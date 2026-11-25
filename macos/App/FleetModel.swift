import AppKit
import Foundation
import UserNotifications

struct AttentionItem: Decodable {
    var account: String
    var accountLabel: String
    var id: String
    var name: String
    var state: String
    var step: String?

    var menuID: String { "\(account):\(id)" }
    var label: String {
        switch state {
        case "error": return "Stuck"
        case "stale": return "Stale"
        default: return "Needs me"
        }
    }
}

private struct StateEnvelope: Decodable {
    var attention: [AttentionItem]
}

enum KeychainStore {
    static let service = "com.autumnavi.BotFleet"
    static let account = "read-key"

    static func save(_ secret: String) -> Bool {
        let data = Data(secret.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func load() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let text = String(data: data, encoding: .utf8),
              !text.isEmpty
        else { return nil }
        return text
    }

    static func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

enum BaseURL {
    private static let key = "botfleet.baseURL"

    static var saved: URL? {
        guard let raw = UserDefaults.standard.string(forKey: key) else { return nil }
        return normalize(raw)
    }

    static func save(_ raw: String) -> URL? {
        guard let url = normalize(raw) else { return nil }
        UserDefaults.standard.set(url.absoluteString, forKey: key)
        return url
    }

    /// Origin only. http is limited to localhost so a read key cannot be sent to some other site.
    static func normalize(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased(),
              !host.isEmpty
        else { return nil }
        let port = url.port.map { ":\($0)" } ?? ""
        if scheme == "https" {
            return URL(string: "https://\(host)\(port)")
        }
        if scheme == "http", host == "localhost" || host == "127.0.0.1" {
            return URL(string: "http://\(host)\(port)")
        }
        return nil
    }

    static func stateURL(_ base: URL) -> URL? {
        var root = base.absoluteString
        if root.hasSuffix("/") { root.removeLast() }
        return URL(string: root + "/api/v1/state")
    }
}

@MainActor
final class FleetModel: ObservableObject {
    @Published var items: [AttentionItem] = []
    @Published var status = "Set the dashboard URL and read key in Settings."
    @Published var showSettings = false
    @Published var reachable = false

    private var timer: Timer?
    private var primed = UserDefaults.standard.bool(forKey: "botfleet.attentionPrimed")
    private var seen: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "botfleet.attentionSeen") ?? [])

    var badge: String { reachable && !items.isEmpty ? "\(items.count)" : "Fleet" }

    init() {
        timer = Timer.scheduledTimer(withTimeInterval: 45, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { await self.refresh() }
        }
        Task { await refresh() }
    }

    func refresh() async {
        guard let base = BaseURL.saved else {
            reachable = false
            items = []
            status = "Set the dashboard URL in Settings."
            return
        }
        guard let key = KeychainStore.load() else {
            reachable = false
            items = []
            status = "Set the read key in Settings."
            return
        }
        guard let endpoint = BaseURL.stateURL(base) else {
            reachable = false
            status = "The dashboard URL is not usable."
            return
        }
        var request = URLRequest(url: endpoint)
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("BotFleet-Mac/2.0", forHTTPHeaderField: "User-Agent")
        request.timeoutInterval = 15
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if code == 401 {
                reachable = false
                items = []
                status = "The read key was refused."
                return
            }
            guard code == 200 else {
                reachable = false
                status = "Fleet replied \(code)."
                return
            }
            let decoded = try JSONDecoder().decode(StateEnvelope.self, from: data)
            noteNewItems(decoded.attention)
            items = decoded.attention
            reachable = true
            status = items.isEmpty ? "Nothing needs you." : "\(items.count) need you."
        } catch {
            reachable = false
            status = "Can't reach Fleet."
        }
    }

    func test(url raw: String, key: String) async -> String {
        guard let base = BaseURL.normalize(raw) else { return "Use an https URL, or http://127.0.0.1." }
        guard key.count >= 32 else { return "The read key is too short." }
        guard let endpoint = BaseURL.stateURL(base) else { return "The dashboard URL is not usable." }
        var request = URLRequest(url: endpoint)
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("BotFleet-Mac/2.0", forHTTPHeaderField: "User-Agent")
        request.timeoutInterval = 15
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if code == 401 { return "Reached Fleet. The read key was refused." }
            guard code == 200 else { return "Reached Fleet. It replied \(code)." }
            let decoded = try JSONDecoder().decode(StateEnvelope.self, from: data)
            return "Connected. \(decoded.attention.count) need you."
        } catch {
            return "Couldn't reach that URL."
        }
    }

    private func noteNewItems(_ next: [AttentionItem]) {
        let ids = Set(next.map(\.menuID))
        defer {
            seen = ids
            primed = true
            UserDefaults.standard.set(Array(ids), forKey: "botfleet.attentionSeen")
            UserDefaults.standard.set(true, forKey: "botfleet.attentionPrimed")
        }
        guard primed else { return }
        let fresh = next.filter { !seen.contains($0.menuID) }
        guard !fresh.isEmpty else { return }
        let content = UNMutableNotificationContent()
        if fresh.count == 1, let only = fresh.first {
            content.title = "\(only.name) needs you"
            content.body = only.label
        } else {
            content.title = "\(fresh.count) bots need you"
            content.body = fresh.prefix(3).map(\.name).joined(separator: ", ")
        }
        let request = UNNotificationRequest(identifier: "botfleet.attention", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
