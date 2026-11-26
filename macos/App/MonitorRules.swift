import Foundation

// Rules for the Monitor view: account switch signals, Use first, the switch banner, coding
// sessions and recently used bots. Pure functions over GET /api/v1/state; no I/O here.

/// OK, Near limit (≥ 80%) or Switch now (≥ 90%, or an exhausted 5-hour window).
enum UsageSignal: Int, Comparable {
    case ok = 0, nearLimit, switchNow

    static let nearAt: Double = 80
    static let switchAt: Double = 90

    static func < (a: UsageSignal, b: UsageSignal) -> Bool { a.rawValue < b.rawValue }

    static func of(used: Double?) -> UsageSignal {
        guard let used else { return .ok }
        if used >= switchAt { return .switchNow }
        if used >= nearAt { return .nearLimit }
        return .ok
    }

    var label: String {
        switch self {
        case .ok: return "OK"
        case .nearLimit: return "Near limit"
        case .switchNow: return "Switch now"
        }
    }

    var tone: Tone {
        switch self {
        case .ok: return .green
        case .nearLimit: return .amber
        case .switchNow: return .red
        }
    }
}

/// One meter on an account tile.
struct MonitorMeter: Hashable {
    /// "5-hour", "Weekly", "Models", "Other", "used".
    var label: String
    /// Percent used; nil when there is no number or no limit.
    var used: Double?
    var noLimit = false
    var resetAt: Double?
    var fiveHour = false

    var signal: UsageSignal {
        if fiveHour && (used ?? 0) >= 100 { return .switchNow }
        return UsageSignal.of(used: used)
    }
}

/// One tile on the accounts strip.
struct AccountCard: Hashable {
    enum Kind: Hashable { case mainClaude, adminClaude, cursor, codex, grokWork, grokAdmin }

    var kind: Kind
    var name: String
    /// The big number(s): one, or Cursor's Models and Other.
    var headline: [MonitorMeter]
    /// The small lines under it ("Weekly 37%", "5-hour no limit").
    var others: [MonitorMeter]
    var resetAt: Double?
    var useFirst = false

    var meters: [MonitorMeter] { headline + others }
    var signal: UsageSignal { meters.map(\.signal).max() ?? .ok }

    /// The meter that sets the signal (the fullest one), for the banner.
    var hottest: MonitorMeter? {
        meters.filter { !$0.noLimit && $0.used != nil }.max { a, b in
            (a.signal, a.used ?? 0) < (b.signal, b.used ?? 0)
        }
    }

    /// Only Main Claude or Cursor is ever a place to switch to.
    var canTakeWork: Bool { kind == .mainClaude || kind == .cursor }
}

/// The slim banner under the top bar while an account is at Switch now.
struct SwitchBanner: Hashable {
    /// "Main Claude · 5-hour 96% · resets 7:12 PM", one per hot account.
    var hot: [String]
    /// "Use Cursor", or why there is nowhere to switch.
    var advice: String
    /// Main Claude or Cursor; nil when neither has room.
    var target: String?

    var text: String { (["Switch now"] + hot + [advice]).joined(separator: " · ") }
}

/// A row in Recently used.
struct RecentBot: Hashable {
    var row: BotRow
    /// The later of the bot's own reports and any coding session it owns.
    var lastAt: Double
    /// One line: its live session, else its summary or step.
    var line: String
    var status: String
    var tone: Tone
    /// In Needs my attention (not saved): gets the dot.
    var needsYou: Bool

    var key: String { row.key }
}

enum MonitorRules {
    static let sessionWindowMs: Double = 24 * 60 * 60 * 1000
    static let recentWindowMs: Double = 7 * 24 * 60 * 60 * 1000
    /// Rows Recently used shows before "Show all".
    static let recentLimit = 12

    // MARK: Accounts

    /// Main Claude, Admin Claude, Cursor, Codex, Grok · Work, then Grok · Admin once it has been
    /// pushed. API pools are not on this strip. Accounts that never reported are left out.
    static func accounts(_ state: FleetState) -> [AccountCard] {
        var cards: [AccountCard] = []
        let byId = Dictionary(state.accounts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        if let a = byId["claudeMax"] { cards.append(windowed(a, kind: .mainClaude, name: "Main Claude")) }
        if let a = byId["claudeAdmin"] { cards.append(windowed(a, kind: .adminClaude, name: "Admin Claude")) }
        if let a = byId["cursor"] { cards.append(cursor(a)) }
        if let a = byId["codex"] { cards.append(windowed(a, kind: .codex, name: "Codex")) }
        if let g = state.grok.first(where: { $0.account == .work }) { cards.append(grok(g, kind: .grokWork, name: "Grok · Work")) }
        if let g = state.grok.first(where: { $0.account == .leaf }) { cards.append(grok(g, kind: .grokAdmin, name: "Grok · Admin")) }
        cards = cards.filter { card in card.meters.contains { $0.used != nil || $0.noLimit } }
        if let i = useFirstIndex(cards) { cards[i].useFirst = true }
        return cards
    }

    /// Main Claude while it has room; Cursor when Main needs a switch and Cursor has room. Never
    /// Admin Claude or Codex.
    static func useFirstIndex(_ cards: [AccountCard]) -> Int? {
        let main = cards.firstIndex { $0.kind == .mainClaude }
        if let main, cards[main].signal != .switchNow { return main }
        if let cursor = cards.firstIndex(where: { $0.kind == .cursor }), cards[cursor].signal != .switchNow { return cursor }
        return nil
    }

    static func banner(_ cards: [AccountCard], now: Double) -> SwitchBanner? {
        let hot = cards.filter { $0.signal == .switchNow }
        if hot.isEmpty { return nil }
        let target = cards.first { $0.useFirst && $0.canTakeWork }?.name
        let advice = target.map { "Use \($0)" } ?? "No room on Main Claude or Cursor"
        return SwitchBanner(hot: hot.map { hotText($0, now: now) }, advice: advice, target: target)
    }

    /// "Main Claude · 5-hour 96% · resets 7:12 PM".
    static func hotText(_ card: AccountCard, now: Double) -> String {
        guard let meter = card.hottest else { return card.name }
        var parts = [card.name]
        let label = meter.label == "used" ? "" : "\(meter.label) "
        parts.append("\(label)\(pct(meter.used ?? 0))")
        if let reset = meter.resetAt ?? card.resetAt { parts.append("resets \(resetText(reset, now: now))") }
        return parts.joined(separator: " · ")
    }

    /// Strip header: "Switch Main Claude", "Grok · Work near limit", or "No switch needed".
    static func headerText(_ cards: [AccountCard]) -> String {
        let hot = cards.filter { $0.signal == .switchNow }.map(\.name)
        if !hot.isEmpty { return "Switch \(hot.joined(separator: ", "))" }
        let near = cards.filter { $0.signal == .nearLimit }.map(\.name)
        if !near.isEmpty { return "\(near.joined(separator: ", ")) near limit" }
        return "No switch needed"
    }

    /// Claude and Codex: the 5-hour window is the big number unless it has no limit; then the weekly.
    private static func windowed(_ a: UsageAccount, kind: AccountCard.Kind, name: String) -> AccountCard {
        let five = Usage.fiveHour(a).map { meter($0, label: "5-hour", fiveHour: true) }
        let week = Usage.weekly(a).map { meter($0, label: "Weekly") }
        var headline: [MonitorMeter] = []
        var others: [MonitorMeter] = []
        if let five, !five.noLimit, five.used != nil {
            headline = [five]
            if let week { others.append(week) }
        } else if let week {
            headline = [week]
            if let five { others.append(five) }
        } else if let primary = Usage.primary(a) {
            headline = [meter(primary, label: primary.label)]
        }
        return AccountCard(kind: kind, name: name, headline: headline, others: others,
                           resetAt: reset(headline + others))
    }

    /// Cursor: Models and Other side by side. The plan month stays off the tile.
    private static func cursor(_ a: UsageAccount) -> AccountCard {
        let models = a.meters.first { $0.id == "cursor-models" }.map { meter($0, label: "Models") }
        let other = a.meters.first { $0.id == "other-models" }.map { meter($0, label: "Other") }
        var headline = [models, other].compactMap { $0 }
        if headline.isEmpty, let primary = Usage.primary(a) { headline = [meter(primary, label: primary.label)] }
        return AccountCard(kind: .cursor, name: "Cursor", headline: headline, others: [], resetAt: reset(headline))
    }

    private static func grok(_ g: GrokUsage, kind: AccountCard.Kind, name: String) -> AccountCard {
        let used = MonitorMeter(label: "used", used: g.pctUsed, resetAt: g.resetAt)
        return AccountCard(kind: kind, name: name, headline: [used], others: [], resetAt: g.resetAt)
    }

    private static func meter(_ m: UsageMeter, label: String, fiveHour: Bool = false) -> MonitorMeter {
        MonitorMeter(label: label, used: m.noLimit ? nil : m.pctUsed, noLimit: m.noLimit, resetAt: m.resetAt,
                     fiveHour: fiveHour)
    }

    /// The reset that matters: the hot meter's, else the soonest one.
    private static func reset(_ meters: [MonitorMeter]) -> Double? {
        let hot = meters.filter { $0.signal != .ok }.max { $0.signal < $1.signal }
        if let at = hot?.resetAt { return at }
        return meters.compactMap(\.resetAt).min()
    }

    /// "3.9%", "60.2%", "6%".
    static func pct(_ value: Double) -> String {
        let tenths = (value * 10).rounded() / 10
        if tenths == tenths.rounded() || tenths >= 100 { return "\(Int(tenths.rounded()))%" }
        return String(format: "%.1f%%", tenths)
    }

    /// "7:07 PM" today, "Fri 6:00 PM" within the week, otherwise "Dec 25".
    static func resetText(_ at: Double, now: Double) -> String {
        if Fmt.isSameDay(at, now) { return Fmt.clock(at) }
        let days = (at - now) / 86_400_000
        if days > 0 && days < 6.5 { return "\(Fmt.reset(at, now: now)) \(Fmt.clock(at))" }
        return Fmt.reset(at, now: now)
    }

    // MARK: Coding sessions

    /// Coding work: a T3, Claude, Cursor or Codex session that is active, or ended and started in
    /// the last week. Tool-less records (API hand-offs, audits) are not coding sessions, and an
    /// old session the collector only now closed is not today's work.
    static func isCodingWork(_ s: CodingSession, now: Double) -> Bool {
        s.tool != nil && (Sessions.isActive(s) || now - s.startedAt < recentWindowMs)
    }

    /// Coding sessions that are active or ended in the last 24 hours. Active first, then the most
    /// recently ended.
    static func sessions(_ d: FleetDerived) -> [CodingSession] {
        let order = ["running", "in_review", "paused_limit", "stalled"]
        let keep = (d.sessions + d.orphans).filter { s in
            isCodingWork(s, now: d.now) && (Sessions.isActive(s) || d.now - endedAt(s) < sessionWindowMs)
        }
        return keep.sorted { a, b in
            let ra = order.firstIndex(of: Sessions.displayStatus(a)) ?? order.count
            let rb = order.firstIndex(of: Sessions.displayStatus(b)) ?? order.count
            if ra != rb { return ra < rb }
            if activityAt(a) != activityAt(b) { return activityAt(a) > activityAt(b) }
            return a.id < b.id
        }
    }

    /// When an ended session stopped. Collector rescans touch `updatedAt`, so `finishedAt` wins.
    static func endedAt(_ s: CodingSession) -> Double { s.finishedAt ?? s.updatedAt }

    /// A session's last sign of life: now-ish while it runs, else when it ended.
    static func activityAt(_ s: CodingSession) -> Double {
        Sessions.isActive(s) ? max(s.updatedAt, s.lastSeenAt ?? 0) : endedAt(s)
    }

    /// Green while live, amber when paused or stalled, red when failed, grey once over.
    static func sessionTone(_ s: CodingSession) -> Tone {
        switch Sessions.displayStatus(s) {
        case "running", "in_review": return .green
        case "paused_limit", "stalled": return .amber
        case "failed": return .red
        default: return .gray
        }
    }

    /// The usage pool by the names on the accounts strip.
    static func poolName(_ s: CodingSession) -> String {
        switch s.account {
        case "claudeMax": return "Main Claude"
        case "claudeAdmin": return "Admin Claude"
        case "cursor": return "Cursor"
        case "cursor-cloud": return "Cursor cloud"
        case "codex": return "Codex"
        default: return s.account.hasPrefix("claudeApi") ? "API" : s.account
        }
    }

    /// "Chief · Chief of Staff" → "Chief".
    static func shortName(_ name: String) -> String {
        guard let range = name.range(of: " · ") else { return name }
        let head = name[..<range.lowerBound].trimmingCharacters(in: .whitespaces)
        return head.isEmpty ? name : head
    }

    // MARK: Recently used

    /// Bots by last activity, newest first: the later of the bot's own reports and any coding
    /// session it owns. Needs-you bots are not pinned; the dot marks them. Bots quiet for a week
    /// drop off unless they need Avi.
    static func recentBots(_ d: FleetDerived) -> [RecentBot] {
        let coding = (d.sessions + d.orphans).filter { isCodingWork($0, now: d.now) }
        var owned: [String: [CodingSession]] = [:]
        for s in coding { if let id = s.ownerBotId { owned[id, default: []].append(s) } }
        let attention = Set(d.attention.map(\.key))
        var out: [RecentBot] = []
        for row in d.rows {
            let mine = (owned[row.bot.id] ?? []).filter { d.owner(of: $0)?.key == row.key }
            let own = [row.bot.statusAt, row.bot.lastReportAt, row.bot.summaryAt].compactMap { $0 }.max()
            let latestSession = mine.max { activityAt($0) < activityAt($1) }
            let sessionAt = latestSession.map(activityAt)
            guard let lastAt = [own, sessionAt].compactMap({ $0 }).max() else { continue }
            let needsYou = attention.contains(row.key)
            if d.now - lastAt > recentWindowMs && !needsYou { continue }
            let live = mine.filter(Sessions.isLive).max { activityAt($0) < activityAt($1) }
            let sessionNewer = (sessionAt ?? 0) > (own ?? 0)
            var line = ownLine(row, d: d)
            if !needsYou, let session = live ?? (sessionNewer ? latestSession : nil) {
                line = Sessions.cleanTitle(session.title)
            }
            let (status, tone) = statusLabel(row, needsYou: needsYou, live: live != nil,
                                             finished: sessionNewer && latestSession.map(Sessions.isActive) == false)
            out.append(RecentBot(row: row, lastAt: lastAt, line: line, status: status, tone: tone, needsYou: needsYou))
        }
        return out.sorted { a, b in
            if a.lastAt != b.lastAt { return a.lastAt > b.lastAt }
            return a.key < b.key
        }
    }

    /// The bot's own line: its summary when that is newer than its step, else the step.
    /// No "[TEST]" prefix and no "No update for …" lead-in (the Stale chip says that).
    private static func ownLine(_ row: BotRow, d: FleetDerived) -> String {
        let step = row.bot.step.map(Rules.clean).flatMap { $0.isEmpty ? nil : $0 } ?? row.step
        let summary = d.oneLine(row)
        let summaryIsNewer = (row.bot.summaryAt ?? 0) >= (row.bot.statusAt ?? 0)
        return summaryIsNewer && summary != row.step ? Rules.clean(summary) : step
    }

    /// Needs you, Stuck or Stale; else Live, Saved, Finished or Idle.
    private static func statusLabel(_ row: BotRow, needsYou: Bool, live: Bool, finished: Bool) -> (String, Tone) {
        if needsYou {
            switch row.state {
            case .error: return ("Stuck", .red)
            case .stale: return ("Stale", .amber)
            default: return ("Needs you", .amber)
            }
        }
        if live || (row.state == .working && row.bot.savedAt == nil) { return ("Live", .green) }
        if row.bot.savedAt != nil { return ("Saved", .violet) }
        if finished { return ("Finished", .gray) }
        return ("Idle", .gray)
    }
}
