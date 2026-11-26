import Foundation

/// A bot plus what the window shows for it.
struct BotRow: Hashable {
    var bot: Bot
    var state: DisplayState
    var step: String

    var key: String { bot.key }
    var account: FleetAccount { bot.account }
}

/// One group card in "Everything else, by account".
struct GroupSummary: Hashable {
    var account: FleetAccount
    var name: String
    var rows: [BotRow]
    var key: String { "\(account.rawValue):\(name)" }
}

/// Everything the three tabs draw, computed once per state and account filter.
/// The partition matches the server: every bot is in exactly one of attention, saved, working, idle.
struct FleetDerived {
    let now: Double
    let filter: AccountFilter
    /// Every bot in the filter, roster order.
    let rows: [BotRow]
    /// Needs my attention: needs me / stuck / stale, not saved, newest status first.
    let attention: [BotRow]
    /// Save for later, most recently saved first.
    let saved: [BotRow]
    let working: [BotRow]
    /// Idle and never reported, not saved. Most recently active first.
    let idle: [BotRow]
    /// Coding sessions in display order (live first). Filtered to bots in the account filter.
    let sessions: [CodingSession]
    /// Sessions with no owner on the roster. Only shown under All.
    let orphans: [CodingSession]
    /// Activity in the filter, newest first.
    let activity: [ActivityItem]

    private let byKey: [String: BotRow]
    private let byId: [String: [Bot]]

    /// `partitionNow` should be the server's `now` from the response so the split equals the server's
    /// attention list; `now` is the ticking clock used for ages.
    init(state: FleetState, filter: AccountFilter, now: Double) {
        self.now = now
        self.filter = filter
        let partitionNow = state.now
        let all = state.bots.map { bot -> BotRow in
            let s = Rules.displayState(bot, now: partitionNow, staleAfterMs: state.staleAfterMs)
            return BotRow(bot: bot, state: s, step: Rules.stepText(bot, state: s, now: now))
        }
        var keyed: [String: BotRow] = [:]
        var ids: [String: [Bot]] = [:]
        for row in all {
            keyed[row.key] = row
            ids[row.bot.id, default: []].append(row.bot)
        }
        byKey = keyed
        byId = ids

        let inFilter = all.filter { filter.matches($0.account) }.sorted(by: Self.rosterOrder)
        rows = inFilter
        let isSaved: (BotRow) -> Bool = { $0.bot.savedAt != nil }
        attention = inFilter
            .filter { !isSaved($0) && $0.state.needsAttention }
            .sorted { ($0.bot.statusAt ?? 0, $1.key) > ($1.bot.statusAt ?? 0, $0.key) }
        saved = inFilter
            .filter(isSaved)
            .sorted { ($0.bot.savedAt ?? 0, $1.key) > ($1.bot.savedAt ?? 0, $0.key) }
        working = inFilter.filter { !isSaved($0) && $0.state == .working }
        idle = inFilter
            .filter { !isSaved($0) && ($0.state == .idle || $0.state == .unknown) }
            .sorted { (Rules.lastSeenAt($0.bot) ?? 0, $1.key) > (Rules.lastSeenAt($1.bot) ?? 0, $0.key) }

        let sorted = Sessions.sorted(state.sessions)
        var owned: [CodingSession] = []
        var lost: [CodingSession] = []
        for session in sorted {
            guard let owner = session.ownerBotId, let bots = ids[owner], !bots.isEmpty else {
                lost.append(session)
                continue
            }
            if bots.contains(where: { filter.matches($0.account) }) { owned.append(session) }
        }
        sessions = owned
        orphans = filter == .all ? lost : []
        activity = state.activity.filter { filter.matches($0.account) }
    }

    private static func rosterOrder(_ a: BotRow, _ b: BotRow) -> Bool {
        if a.bot.sortIndex != b.bot.sortIndex { return a.bot.sortIndex < b.bot.sortIndex }
        let byName = a.bot.name.localizedCaseInsensitiveCompare(b.bot.name)
        if byName != .orderedSame { return byName == .orderedAscending }
        return a.key < b.key
    }

    func row(_ key: String) -> BotRow? { byKey[key] }

    /// The bot that started a session: Avi's Work first when the id is on both rosters.
    func owner(of session: CodingSession) -> Bot? {
        guard let id = session.ownerBotId, let bots = byId[id] else { return nil }
        return bots.first { $0.account == .work } ?? bots.first
    }

    /// "started by" text: the roster name, else the collector's ownerName, else Unassigned.
    func ownerName(of session: CodingSession) -> String {
        owner(of: session)?.name ?? session.ownerName ?? "Unassigned"
    }

    /// Sessions a bot started (any status), in display order.
    func sessions(for bot: Bot) -> [CodingSession] {
        sessions.filter { $0.ownerBotId == bot.id }
    }

    /// Activity for one bot, newest first.
    func activity(for bot: Bot) -> [ActivityItem] {
        activity.filter { $0.account == bot.account && $0.botId == bot.id }
    }

    /// Group cards for one account, in roster group order. Empty groups are dropped.
    func groups(for account: FleetAccount) -> [GroupSummary] {
        let mine = rows.filter { $0.account == account }
        var names = Rules.groupOrder.filter { name in mine.contains { $0.bot.group == name } }
        for row in mine where !names.contains(row.bot.group) { names.append(row.bot.group) }
        return names.map { name in
            GroupSummary(account: account, name: name, rows: mine.filter { $0.bot.group == name })
        }
    }

    func count(_ account: FleetAccount) -> (bots: Int, needYou: Int) {
        (rows.filter { $0.account == account }.count, attention.filter { $0.account == account }.count)
    }

    /// Accounts shown in "by account" sections: those in the filter that have bots.
    var accountsWithBots: [FleetAccount] {
        filter.accounts.filter { account in rows.contains { $0.account == account } }
    }
}

// MARK: Coding sessions (src/shared/sessions.ts)

enum Sessions {
    /// running, in_review, paused_limit, stalled, failed, aborted, stopped, finished.
    static func displayStatus(_ s: CodingSession) -> String {
        s.status == "running" && !s.alive ? "stalled" : s.status
    }

    private static let order = ["running", "in_review", "paused_limit", "stalled", "failed", "aborted", "stopped", "finished"]

    static func sorted(_ sessions: [CodingSession]) -> [CodingSession] {
        sessions.sorted { a, b in
            let ra = order.firstIndex(of: displayStatus(a)) ?? order.count
            let rb = order.firstIndex(of: displayStatus(b)) ?? order.count
            if ra != rb { return ra < rb }
            if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt }
            if a.title != b.title { return a.title < b.title }
            return a.id < b.id
        }
    }

    /// Running or in review: what "live" counts (paused and stalled are counted separately).
    static func isLive(_ s: CodingSession) -> Bool {
        ["running", "in_review"].contains(displayStatus(s))
    }

    static func isActive(_ s: CodingSession) -> Bool {
        ["running", "in_review", "paused_limit", "stalled"].contains(displayStatus(s))
    }

    /// Label in the design: running sessions read "Live".
    static func statusLabel(_ s: CodingSession) -> String {
        switch displayStatus(s) {
        case "running": return "Live"
        case "paused_limit": return "Paused · limit"
        case "stalled": return "Stalled"
        case "finished": return "Finished"
        case "failed": return "Failed"
        case "aborted": return "Aborted"
        case "stopped": return "Stopped"
        case "in_review": return "In review"
        default: return s.status
        }
    }

    static func tone(_ s: CodingSession) -> Tone {
        switch displayStatus(s) {
        case "running", "in_review": return .blue
        case "paused_limit", "stalled": return .amber
        case "finished": return .green
        default: return .red
        }
    }

    /// Tool badge text: Claude, T3, Cursor, Codex, or the source id.
    static func toolLabel(_ s: CodingSession) -> String {
        switch s.tool {
        case "claude": return "Claude"
        case "t3": return "T3"
        case "cursor", "cursor-cloud": return "Cursor"
        default: break
        }
        if s.account == "cursor" || s.account == "cursor-cloud" { return "Cursor" }
        if s.account == "codex" { return "Codex" }
        if s.account.hasPrefix("claude") { return "Claude" }
        return s.account
    }

    /// Title plus "(cloud)" and the helper count, as on the web.
    static func title(_ s: CodingSession) -> String {
        let isCloud = s.tool == "cursor-cloud" || s.account == "cursor-cloud"
        let cloud = isCloud && s.title.range(of: "cloud", options: .caseInsensitive) == nil ? " (cloud)" : ""
        let n = s.helperList.count
        let helpers = n > 0 ? " · \(n) helper\(n == 1 ? "" : "s")" : ""
        return s.title + cloud + helpers
    }

    /// 0–1, or nil when the collector didn't send a step count.
    static func progress(_ s: CodingSession) -> Double? {
        guard let step = s.step, let steps = s.steps, steps > 0 else { return nil }
        return min(1, max(0, Double(step) / Double(steps)))
    }

    static func stepText(_ s: CodingSession) -> String? {
        guard let step = s.step, let steps = s.steps, steps > 0 else { return nil }
        return "\(step)/\(steps)"
    }

    /// "52m", or "<1m" for a session that just started.
    static func runtime(_ s: CodingSession, now: Double) -> String {
        let end = s.finishedAt ?? now
        let ms = max(0, end - s.startedAt)
        return ms < 60_000 ? "<1m" : Fmt.duration(ms)
    }

    /// FYI badge only (PR ready, Paused · limit, Stalled). Never a Needs-my-attention item.
    static func attentionBadge(_ s: CodingSession) -> String? {
        switch s.attentionReason {
        case "pr_ready": return "PR ready"
        case "paused_limit": return "Paused · limit"
        case "stalled": return "Stalled"
        default: return nil
        }
    }

    /// Which usage pool a session runs on: "Claude · Avi's Work", "Cursor", …
    static func poolName(_ s: CodingSession) -> String {
        switch s.account {
        case "claudeMax": return "Claude · Avi's Work"
        case "claudeAdmin": return "Claude · Admin"
        case "cursor": return "Cursor"
        case "cursor-cloud": return "Cursor cloud"
        case "codex": return "Codex"
        default: return s.account
        }
    }

    /// "PR #31" from a GitHub pull URL, else "PR".
    static func prLabel(_ url: String) -> String {
        if let range = url.range(of: #"/pull/(\d+)"#, options: .regularExpression) {
            return "PR #" + url[range].dropFirst("/pull/".count)
        }
        return "PR"
    }

    /// "6 live · 1 paused · 1 finished".
    static func summary(_ sessions: [CodingSession]) -> String {
        var live = 0, paused = 0, finished = 0, failed = 0
        for s in sessions {
            switch displayStatus(s) {
            case "running", "in_review": live += 1
            case "paused_limit", "stalled": paused += 1
            case "finished": finished += 1
            default: failed += 1
            }
        }
        var parts: [String] = []
        if live > 0 { parts.append("\(live) live") }
        if paused > 0 { parts.append("\(paused) paused") }
        if finished > 0 { parts.append("\(finished) finished") }
        if failed > 0 { parts.append("\(failed) failed") }
        return parts.isEmpty ? "none" : parts.joined(separator: " · ")
    }

    /// "⌨ 1 coding session" on a working card. Active sessions only.
    static func codingNote(_ sessions: [CodingSession]) -> String? {
        let active = sessions.filter(isActive)
        if active.isEmpty { return nil }
        let paused = active.filter { displayStatus($0) == "paused_limit" }.count
        if paused == active.count { return paused == 1 ? "1 session paused" : "\(paused) sessions paused" }
        return active.count == 1 ? "1 coding session" : "\(active.count) coding sessions"
    }

    /// Only https links are opened.
    static func safeURL(_ raw: String?) -> URL? {
        guard let raw, let url = URL(string: raw), url.scheme?.lowercased() == "https", url.host != nil else { return nil }
        return url
    }
}

// MARK: Usage (src/shared/usage.ts)

enum Usage {
    static let weeklyResetWindowMs: Double = 48 * 60 * 60 * 1000

    /// Top-row name. Claude accounts are named after the Grok account they belong to.
    static func displayName(_ a: UsageAccount) -> String {
        switch a.id {
        case "claudeMax": return "Claude · Avi's Work"
        case "claudeAdmin": return "Claude · Admin"
        case "cursor": return "Cursor"
        case "codex": return "Codex"
        default: return a.label
        }
    }

    static func sorted(_ accounts: [UsageAccount]) -> [UsageAccount] {
        let known = ["claudeMax", "claudeAdmin", "cursor", "codex"]
        func rank(_ a: UsageAccount) -> Int {
            if let i = known.firstIndex(of: a.id) { return i }
            return a.group == "api" ? 100 : 50
        }
        return accounts.sorted { a, b in
            if rank(a) != rank(b) { return rank(a) < rank(b) }
            if a.label != b.label { return a.label < b.label }
            return a.id < b.id
        }
    }

    static func isWeekly(_ m: UsageMeter) -> Bool {
        "\(m.id) \(m.label)".range(of: "week", options: .caseInsensitive) != nil
    }

    static func isFiveHour(_ m: UsageMeter) -> Bool {
        "\(m.id) \(m.label)".range(of: #"(^|[^a-z0-9])5\s*-?\s*h(our)?s?\b|five[ -]?hour"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func fiveHour(_ a: UsageAccount) -> UsageMeter? { a.meters.first(where: isFiveHour) }
    static func weekly(_ a: UsageAccount) -> UsageMeter? { a.meters.first(where: isWeekly) }

    /// The meter that drives the big number: the 5-hour window, else the first non-weekly meter.
    static func primary(_ a: UsageAccount) -> UsageMeter? {
        fiveHour(a) ?? a.meters.first { !isWeekly($0) } ?? a.meters.first
    }

    /// Percent left, 0–100. Nil when there is no percentage or no limit.
    static func remaining(_ m: UsageMeter) -> Double? {
        guard !m.noLimit, let used = m.pctUsed else { return nil }
        return min(100, max(0, 100 - used))
    }

    /// The weekly reset is shown only when it is still ahead and inside 48 hours.
    static func showWeeklyReset(_ m: UsageMeter, now: Double) -> Bool {
        guard let reset = m.resetAt else { return false }
        let delta = reset - now
        return delta >= 0 && delta <= weeklyResetWindowMs
    }

    static func money(_ value: Money?) -> String? {
        guard let value else { return nil }
        if let text = value.text { return text }
        guard let amount = value.amount else { return nil }
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US")
        f.numberStyle = .currency
        f.currencySymbol = "$"
        let whole = amount.rounded() == amount
        f.minimumFractionDigits = whole ? 0 : 2
        f.maximumFractionDigits = whole ? 0 : 2
        return f.string(from: NSNumber(value: amount)) ?? "$\(amount)"
    }

    /// API pool remaining / granted, 0–100.
    static func apiRemaining(_ a: UsageAccount) -> Double? {
        guard let remaining = a.remaining?.amount, let granted = a.granted?.amount, granted > 0 else { return nil }
        return min(100, max(0, remaining / granted * 100))
    }

    /// Bar colour for percent left, by group (same thresholds as the web).
    static func leftTone(_ left: Double?, group: String) -> Tone {
        guard let left else { return group == "api" ? .violet : .green }
        if group == "api" { return left < 25 ? .red : .violet }
        if group == "cursor" { return left < 20 ? .red : .blue }
        if left < 25 { return .red }
        if left < 40 { return .amber }
        return .green
    }

    static func grokTop(_ usage: GrokUsage) -> (top: [GrokBotUsage], others: Int, othersShare: Double) {
        let sorted = usage.bots.sorted { $0.share > $1.share }
        let top = Array(sorted.prefix(8))
        let rest = sorted.dropFirst(8)
        return (top, rest.count, rest.reduce(0) { $0 + $1.share })
    }

    /// A bot whose routines are at least half its share is drawn as "mostly routines".
    static func mostlyRoutines(_ bot: GrokBotUsage) -> Bool {
        guard let routines = bot.routinesShare, bot.share > 0 else { return false }
        return routines >= bot.share / 2
    }
}
