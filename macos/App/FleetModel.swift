import AppKit
import Foundation
import UserNotifications

/// Why the last read did not produce fresh data. The last good data stays on screen.
enum FetchProblem: Equatable {
    case offline(String)
    case unauthorized
    case notV2
    case server(Int)
    case decode
    case badURL

    var title: String {
        switch self {
        case .offline: return "Offline"
        case .unauthorized: return "Read key refused"
        case .notV2: return "Not Bot Fleet v2"
        case .server: return "Fleet error"
        case .decode: return "Unreadable reply"
        case .badURL: return "Bad dashboard URL"
        }
    }

    var detail: String {
        switch self {
        case .offline(let why): return why
        case .unauthorized: return "Fleet refused the read key. Paste it again in Settings."
        case .notV2: return "GET /api/v1/state returned 404. This server is still the older dashboard."
        case .server(let code): return "Fleet answered HTTP \(code)."
        case .decode: return "Fleet sent data this version of the app can't read."
        case .badURL: return "The dashboard URL in Settings is not usable."
        }
    }
}

/// Why a Save for later change did not go through. Shown in the toast after the change is undone.
enum SaveFailure: Error, Equatable {
    case noKey, badURL, refused, notControl, notFound, rateLimited
    case server(Int)
    case offline(String)

    var message: String {
        switch self {
        case .noKey: return "No control key in Settings."
        case .badURL: return "The dashboard URL is not usable."
        case .refused: return "Fleet refused the control key."
        case .notControl: return "That key can't change Save for later."
        case .notFound: return "Fleet doesn't know this bot."
        case .rateLimited: return "Too many changes. Try again in a minute."
        case .server(let code): return "Fleet answered HTTP \(code)."
        case .offline(let why): return why
        }
    }
}

/// The toast under the window after Later or Move back: "Saved for later · Undo", or the error.
struct SaveToast: Equatable {
    let id = UUID()
    var text: String
    /// What Undo sends: the bot and the saved value to go back to. Nil when there is no Undo.
    var undo: Bot?
    var undoSaved = false
    var isError = false
}

enum DashboardTab: String, CaseIterable, Hashable {
    case focus, board, feed
    var title: String { rawValue.capitalized }
}

/// Reads GET /api/v1/state with the read key every 20 seconds (URLSession only, no web view),
/// plus right away on launch, wake and Refresh. It never messages a bot. Its only write is Save for
/// later (`setSaved`), signed with the separate control key.
@MainActor
final class FleetModel: ObservableObject {
    static let pollSeconds: Double = 20

    @Published var state: FleetState?
    @Published var problem: FetchProblem?
    /// Server time of the last good read.
    @Published var lastSuccess: Date?
    @Published var configured: Bool
    /// A control key is in the Keychain, so Later and Move back are shown.
    @Published var canSave: Bool
    @Published var showSettings = false
    /// Last HTTP status from /api/v1/state. 404 means the server is not v2 yet.
    @Published var httpStatus: Int?
    @Published var tab: DashboardTab {
        didSet { UserDefaults.standard.set(tab.rawValue, forKey: "botfleet.tab") }
    }
    @Published var filter: AccountFilter {
        didSet {
            UserDefaults.standard.set(filter.rawValue, forKey: "botfleet.filter")
            // The activity page is fetched per account, so a new filter reads again.
            if oldValue != filter { poke() }
        }
    }
    /// The bot the Focus card shows (`account:id`). Nil means the first one that needs Avi.
    @Published var focusKey: String?
    /// The Save for later toast, cleared after about 6 seconds.
    @Published var toast: SaveToast?
    /// Changes sent but not yet answered, per `account:id`. Re-applied to every read until Fleet
    /// answers, so a poll in between never flips the bot back.
    private struct PendingSave {
        var saved: Bool
        /// The newest change for this bot; only its answer settles the bot.
        var token: Int
        /// The last `savedAt` Fleet confirmed, which a failure goes back to.
        var confirmed: Double?
    }
    private var pendingSaved: [String: PendingSave] = [:]
    private var saveToken = 0
    /// Bumped when the server or control key changes, so queued sends for the old one are dropped.
    private var saveEpoch = 0
    /// Sends run one after another, so Undo never overtakes the change it undoes.
    private var saveChain: Task<Void, Never>?
    /// Ticks with every poll so ages and the header clock move even when nothing changed.
    @Published private(set) var tick = Date()

    /// Server clock minus local clock, from the last good reply.
    private var skewMs: Double = 0
    /// CI snapshots freeze the clock at the sample's `now`.
    private var fixedNow: Double?
    private var loop: Task<Void, Never>?
    private var generation = 0
    private var observers: [NSObjectProtocol] = []
    private var primed = UserDefaults.standard.bool(forKey: "botfleet.attentionPrimed")
    private var seen: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "botfleet.attentionSeen") ?? [])

    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 15
        return URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }()

    init() {
        configured = BaseURL.saved != nil && KeychainStore.load() != nil
        canSave = ControlKey.load() != nil
        tab = DashboardTab(rawValue: UserDefaults.standard.string(forKey: "botfleet.tab") ?? "") ?? .focus
        filter = AccountFilter(rawValue: UserDefaults.standard.string(forKey: "botfleet.filter") ?? "") ?? .all
        let center = NSWorkspace.shared.notificationCenter
        observers.append(center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            // Give Wi-Fi a moment to come back, or the first read after wake reports Offline.
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                self?.poke()
            }
        })
        poke()
    }

    /// For CI snapshots: fixed data, frozen clock, no network.
    init(preview: FleetState, tab: DashboardTab, filter: AccountFilter = .all, problem: FetchProblem? = nil) {
        configured = true
        canSave = true
        self.tab = tab
        self.filter = filter
        state = preview
        self.problem = problem
        httpStatus = 200
        fixedNow = preview.now
        lastSuccess = Fmt.date(preview.now - (problem == nil ? 8_000 : 6 * 60_000))
    }

    /// Current time in server milliseconds.
    var now: Double { fixedNow ?? (Date().timeIntervalSince1970 * 1000 + skewMs) }

    var needsSetup: Bool { !configured }
    var reachable: Bool { problem == nil && state != nil }
    /// Attention items as the server counts them. The menu bar uses this.
    var items: [AttentionItem] { state?.attention ?? [] }
    var badge: String { reachable && !items.isEmpty ? "\(items.count)" : "Fleet" }

    var status: String {
        if !configured { return "Add the dashboard URL and read key to start." }
        switch problem {
        case .some(.notV2): return "This server doesn't have Bot Fleet v2 yet."
        case .some(.unauthorized): return "The read key was refused."
        case .some(.offline): return "Can't reach Fleet."
        case .some(.server(let code)): return "Fleet replied \(code)."
        case .some(.decode): return "Fleet sent data this app can't read."
        case .some(.badURL): return "The dashboard URL is not usable."
        case .none:
            guard state != nil else { return "Connecting…" }
            return items.isEmpty ? "Nothing needs you." : "\(items.count) need you."
        }
    }

    /// Refresh now and restart the 20-second cadence.
    func poke() {
        guard fixedNow == nil else { return }
        // Drop the reply of any read in flight, so a cancelled request never shows as Offline.
        generation += 1
        loop?.cancel()
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                try? await Task.sleep(nanoseconds: UInt64(Self.pollSeconds * 1_000_000_000))
            }
        }
    }

    func refresh() async {
        guard fixedNow == nil else { return }
        generation += 1
        let mine = generation
        tick = Date()
        configured = BaseURL.saved != nil && KeychainStore.load() != nil
        guard let base = BaseURL.saved, let key = KeychainStore.load() else {
            state = nil
            problem = nil
            httpStatus = nil
            return
        }
        guard let endpoint = BaseURL.stateURL(base, account: filter) else {
            problem = .badURL
            httpStatus = nil
            return
        }
        let result = await fetch(endpoint, key: key)
        guard mine == generation, !Task.isCancelled else { return }
        switch result {
        case .cancelled:
            return
        case .success(let reply, let code):
            var fresh = reply
            httpStatus = code
            skewMs = fresh.now - Date().timeIntervalSince1970 * 1000
            for (key, change) in pendingSaved {
                let current = fresh.bots.first { $0.key == key }?.savedAt
                fresh.applySaved(key: key, savedAt: change.saved ? (current ?? fresh.now) : nil)
            }
            noteNewItems(fresh.attention)
            state = fresh
            problem = nil
            lastSuccess = Fmt.date(fresh.now)
            tick = Date()
        case .failure(let failure, let code):
            httpStatus = code
            problem = failure
            if failure == .notV2 { state = nil }
        }
    }

    private enum Outcome {
        case success(FleetState, Int)
        case failure(FetchProblem, Int?)
        case cancelled
    }

    private func fetch(_ endpoint: URL, key: String) async -> Outcome {
        var request = URLRequest(url: endpoint)
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("BotFleet-Mac/2.1", forHTTPHeaderField: "User-Agent")
        do {
            let (data, response) = try await session.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            switch code {
            case 200:
                guard let decoded = try? JSONDecoder().decode(FleetState.self, from: data) else {
                    return .failure(.decode, code)
                }
                return .success(decoded, code)
            case 401, 403: return .failure(.unauthorized, code)
            case 404: return .failure(.notV2, code)
            default: return .failure(.server(code), code)
            }
        } catch let error as URLError where error.code == .cancelled {
            return .cancelled
        } catch is CancellationError {
            return .cancelled
        } catch let error as URLError {
            return .failure(.offline(Self.describe(error)), nil)
        } catch {
            return .failure(.offline("Can't reach Fleet."), nil)
        }
    }

    /// Later (saved = true) or Move back (false): shown at once, sent with the control key, then
    /// read back. On an error the bot goes back to where it was and the toast says why.
    func setSaved(_ bot: Bot, saved: Bool, offerUndo: Bool = true) {
        guard canSave, var current = state else { return }
        let shown = current.bots.first { $0.key == bot.key }?.savedAt
        // While an earlier change is unanswered, what Fleet confirmed is older than what is shown.
        let confirmed: Double? = pendingSaved[bot.key].map { $0.confirmed } ?? shown
        let at: Double? = saved ? now : nil
        current.applySaved(key: bot.key, savedAt: at)
        // A read already in flight predates this change; drop its reply.
        generation += 1
        state = current
        // Moving back must not ring as a new "needs you".
        if !saved { seen.insert(bot.key) }
        saveToken += 1
        let token = saveToken
        pendingSaved[bot.key] = PendingSave(saved: saved, token: token, confirmed: confirmed)
        show(SaveToast(text: saved ? "Saved for later" : "Moved back", undo: offerUndo ? bot : nil, undoSaved: !saved))
        guard fixedNow == nil else { return }
        let epoch = saveEpoch
        let previous = saveChain
        saveChain = Task { [weak self] in
            await previous?.value
            guard let self, self.saveEpoch == epoch, !Task.isCancelled else { return }
            let failure = await self.sendSaved(account: bot.account, botId: bot.id, saved: saved)
            // The server or key changed meanwhile: this answer belongs to the old one.
            guard self.saveEpoch == epoch else { return }
            guard let entry = self.pendingSaved[bot.key] else { return }
            guard entry.token == token else {
                // A newer change for this bot is queued; it settles the bot. Only remember what landed.
                if failure == nil { self.pendingSaved[bot.key]?.confirmed = at }
                return
            }
            self.pendingSaved[bot.key] = nil
            if let failure {
                if var current = self.state {
                    current.applySaved(key: bot.key, savedAt: entry.confirmed)
                    self.state = current
                }
                // Back in Needs my attention is not news.
                if entry.confirmed == nil { self.seen.insert(bot.key) }
                let verb = saved ? "save" : "move back"
                self.show(SaveToast(text: "Couldn't \(verb) \(bot.name). \(failure.message)", isError: true))
            }
            self.poke()
        }
    }

    /// Drops queued and unanswered Save for later changes and the toast (new server or key).
    func resetSaves() {
        saveEpoch += 1
        saveChain?.cancel()
        saveChain = nil
        pendingSaved = [:]
        toast = nil
    }

    /// Settings → Remove: no control key, so no buttons and nothing left to send.
    func removeControlKey() {
        ControlKey.delete()
        canSave = false
        resetSaves()
    }

    func undo(_ toast: SaveToast) {
        guard let bot = toast.undo else { return }
        setSaved(bot, saved: toast.undoSaved, offerUndo: false)
    }

    private func show(_ next: SaveToast) {
        toast = next
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if self?.toast?.id == next.id { self?.toast = nil }
        }
    }

    /// POST /api/v1/bots/<account>/<id>/saved with {"saved": …}, signed with the control key. The
    /// only write the app makes; the read key is never sent here. Nil means Fleet accepted it.
    func sendSaved(account: FleetAccount, botId: String, saved: Bool) async -> SaveFailure? {
        guard let base = BaseURL.saved, let endpoint = BaseURL.savedURL(base, account: account, botId: botId) else {
            return .badURL
        }
        guard let key = ControlKey.load() else { return .noKey }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("BotFleet-Mac/2.1", forHTTPHeaderField: "User-Agent")
        request.httpBody = Data((saved ? #"{"saved":true}"# : #"{"saved":false}"#).utf8)
        do {
            let (_, response) = try await session.data(for: request)
            switch (response as? HTTPURLResponse)?.statusCode ?? 0 {
            case 200: return nil
            case 401: return .refused
            case 403: return .notControl
            case 404: return .notFound
            case 429: return .rateLimited
            case let code: return .server(code)
            }
        } catch let error as URLError {
            return .offline(Self.describe(error))
        } catch {
            return .offline("Can't reach Fleet.")
        }
    }

    static func describe(_ error: URLError) -> String {
        switch error.code {
        case .notConnectedToInternet, .networkConnectionLost: return "This Mac is offline."
        case .timedOut: return "Fleet didn't answer within 15 seconds."
        case .cannotFindHost, .dnsLookupFailed, .cannotConnectToHost: return "Can't reach the dashboard URL."
        case .secureConnectionFailed, .serverCertificateUntrusted: return "The secure connection to Fleet failed."
        default: return "Can't reach Fleet."
        }
    }

    /// Settings → Test. Never stores anything.
    func test(url raw: String, key: String) async -> String {
        guard let base = BaseURL.normalize(raw) else { return "Use an https URL, or http://127.0.0.1." }
        guard key.count >= 32 else { return "The read key is too short." }
        guard let endpoint = BaseURL.stateURL(base) else { return "The dashboard URL is not usable." }
        switch await fetch(endpoint, key: key) {
        case .success(let state, _):
            return "Connected. \(state.attention.count) need you."
        case .failure(.notV2, _):
            return "This server doesn't have Bot Fleet v2 yet. /api/v1/state returned 404."
        case .failure(.unauthorized, _):
            return "Reached Fleet. The read key was refused."
        case .failure(.server(let code), _):
            return "Reached Fleet. It replied \(code)."
        case .failure(.decode, _):
            return "Reached Fleet, but couldn't read its reply."
        case .failure(let other, _):
            return other.detail
        case .cancelled:
            return "Cancelled."
        }
    }

    /// Saves the dashboard URL (origin only). A different server drops the old one's data first.
    func saveServer(_ raw: String) -> Bool {
        let previous = BaseURL.saved
        guard let saved = BaseURL.save(raw) else { return false }
        if saved != previous { forgetServerData() }
        return true
    }

    /// Settings pointed the app at another server: drop the old server's data and notification
    /// baseline so nothing from it is shown as "last good" Fleet data, and its control key so it is
    /// never sent anywhere else.
    func forgetServerData() {
        removeControlKey()
        generation += 1
        state = nil
        problem = nil
        lastSuccess = nil
        httpStatus = nil
        focusKey = nil
        primed = false
        seen = []
        UserDefaults.standard.set(false, forKey: "botfleet.attentionPrimed")
        UserDefaults.standard.removeObject(forKey: "botfleet.attentionSeen")
    }

    /// Menu bar: show this bot in the Focus tab.
    func focus(on key: String) {
        if let item = items.first(where: { $0.key == key }), !filter.matches(item.account) {
            filter = .all
        }
        focusKey = key
        tab = .focus
    }

    /// A notification when a bot newly enters Needs my attention. The first good read is a baseline.
    private func noteNewItems(_ next: [AttentionItem]) {
        let ids = Set(next.map(\.key))
        defer {
            seen = ids
            primed = true
            UserDefaults.standard.set(Array(ids), forKey: "botfleet.attentionSeen")
            UserDefaults.standard.set(true, forKey: "botfleet.attentionPrimed")
        }
        guard primed else { return }
        let fresh = next.filter { !seen.contains($0.key) }
        guard !fresh.isEmpty else { return }
        let content = UNMutableNotificationContent()
        if fresh.count == 1, let only = fresh.first {
            content.title = "\(only.name) needs you"
            content.body = "\(DisplayState(attentionState: only.state).label) · \(only.accountLabel)"
        } else {
            content.title = "\(fresh.count) bots need you"
            content.body = fresh.prefix(3).map(\.name).joined(separator: ", ")
        }
        let request = UNNotificationRequest(identifier: "botfleet.attention", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}

extension FleetState {
    /// Puts a bot in or out of Save for later locally, and keeps the attention list (the menu bar
    /// count) in step: a saved bot leaves it; a moved-back bot that needs Avi rejoins it.
    mutating func applySaved(key: String, savedAt: Double?) {
        guard let index = bots.firstIndex(where: { $0.key == key }) else { return }
        bots[index].savedAt = savedAt
        let bot = bots[index]
        attention.removeAll { $0.key == key }
        guard savedAt == nil else { return }
        let shown = Rules.displayState(bot, now: now, staleAfterMs: staleAfterMs)
        guard shown.needsAttention else { return }
        attention.append(AttentionItem(account: bot.account, accountLabel: bot.account.label, id: bot.id,
                                       name: bot.name, group: bot.group, state: shown.rawValue,
                                       step: bot.step, statusAt: bot.statusAt))
    }
}

/// Never follow a redirect: the read key goes only to the saved origin. A 3xx shows as a server error.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
