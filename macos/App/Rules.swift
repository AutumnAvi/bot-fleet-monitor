import Foundation

// Pure view-model rules, ported from src/shared (status.ts, fleet-view.ts, time.ts) so the
// window says the same thing as the web dashboard. No I/O here.

/// What a bot shows. `unknown` = never reported; `stale` = working but silent too long.
enum DisplayState: String, Hashable {
    case waitingUser = "waiting_user", working, idle, error, stale, unknown

    init(attentionState raw: String) {
        switch raw {
        case "error": self = .error
        case "stale": self = .stale
        default: self = .waitingUser
        }
    }

    var label: String {
        switch self {
        case .waitingUser: return "Needs me"
        case .working: return "Working"
        case .idle: return "Idle"
        case .unknown: return "No status yet"
        case .error: return "Stuck"
        case .stale: return "Stale"
        }
    }

    var tone: Tone {
        switch self {
        case .waitingUser: return .amber
        case .working: return .blue
        case .error: return .red
        case .stale: return .pink
        case .idle, .unknown: return .gray
        }
    }

    /// Needs me or Stuck (including stale): pulls a bot into Needs my attention.
    var needsAttention: Bool { self == .waitingUser || self == .error || self == .stale }
}

enum AccountFilter: String, CaseIterable, Hashable {
    case all, work, leaf

    var label: String {
        switch self {
        case .all: return "All"
        case .work: return FleetAccount.work.label
        case .leaf: return FleetAccount.leaf.label
        }
    }

    func matches(_ account: FleetAccount) -> Bool {
        switch self {
        case .all: return true
        case .work: return account == .work
        case .leaf: return account == .leaf
        }
    }

    var accounts: [FleetAccount] {
        switch self {
        case .all: return [.work, .leaf]
        case .work: return [.work]
        case .leaf: return [.leaf]
        }
    }
}

enum Rules {
    static let workGroups = ["Main", "PMs", "Asana", "Sub-Bots", "Unassigned"]
    static let leafGroup = "Leaf account"
    static let groupOrder = workGroups + [leafGroup]

    /// The web calls the stored "Leaf account" group "Admin bots".
    static func groupName(_ group: String) -> String { group == leafGroup ? "Admin bots" : group }

    /// Most recent sign of life: the last report of any kind.
    static func lastSeenAt(_ bot: Bot) -> Double? {
        guard let status = bot.statusAt else { return bot.lastReportAt }
        guard let report = bot.lastReportAt else { return status }
        return max(status, report)
    }

    static func displayState(_ bot: Bot, now: Double, staleAfterMs: Double) -> DisplayState {
        guard let raw = bot.status, let statusAt = bot.statusAt else { return .unknown }
        switch raw {
        case "working":
            return now - (lastSeenAt(bot) ?? statusAt) >= staleAfterMs ? .stale : .working
        case "waiting_user": return .waitingUser
        case "error": return .error
        case "idle": return .idle
        default: return .unknown
        }
    }

    /// Display text without a leftover "[TEST] " prefix (some bots still send one).
    static func clean(_ text: String) -> String {
        var out = text.trimmingCharacters(in: .whitespaces)
        while let range = out.range(of: #"^\[test\]\s*"#, options: [.regularExpression, .caseInsensitive]) {
            out.removeSubrange(range)
        }
        return out
    }

    static func stepText(_ bot: Bot, state: DisplayState, now: Double) -> String {
        let step = bot.step.map(clean).flatMap { $0.isEmpty ? nil : $0 }
        switch state {
        case .unknown: return "No status yet"
        case .stale:
            let silent = "No update for \(Fmt.duration(now - (lastSeenAt(bot) ?? now)))"
            return step.map { "\(silent) · \($0)" } ?? silent
        case .idle: return step ?? "Idle"
        case .working: return step ?? "Working"
        case .waitingUser: return step ?? "Waiting on you"
        case .error: return step ?? "Stuck"
        }
    }

    /// Deep link Avi clicks. Opens whichever Grok Bot account the app is signed into, so the label names the account.
    static func openURL(botId: String) -> URL? {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        guard let id = botId.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: "grokbot://app/v1/agent?id=\(id)")
    }

    static func openLabel(_ account: FleetAccount) -> String { "Open chat · \(account.label)" }

    /// Two letters from a bot's name, for avatars.
    static func initials(_ name: String) -> String {
        let separators = CharacterSet(charactersIn: " ·•|/").union(.whitespaces)
        let words = name.components(separatedBy: separators).filter { word in
            word.unicodeScalars.contains { CharacterSet.alphanumerics.contains($0) }
        }
        func letters(_ word: String) -> [Character] {
            word.filter { $0.isLetter || $0.isNumber }.map { $0 }
        }
        guard let first = words.first else { return "•" }
        if words.count == 1 {
            let chars = letters(first).prefix(2)
            return chars.isEmpty ? "•" : String(chars).uppercased()
        }
        let a = letters(first).first.map { String($0) } ?? ""
        let b = letters(words[1]).first.map { String($0) } ?? ""
        let out = (a + b).uppercased()
        return out.isEmpty ? "•" : out
    }

    /// Short label for an activity kind (src/shared/fleet-view.ts `activityLabel`).
    static func activityLabel(kind: String) -> String {
        switch kind {
        case "working": return "Working"
        case "waiting_user": return "Needs you"
        case "error": return "Stuck"
        case "idle": return "Idle"
        case "done": return "Done"
        case "summary": return "Summary"
        case "message": return "Sent you"
        case "avi_replied": return "You replied"
        case "saved": return "Saved"
        case "unsaved": return "Unsaved"
        default: return kind
        }
    }

    /// What comes after the label: the step, or the message text quoted. Never a prefix.
    static func activityDetail(kind: String, detail: String?) -> String? {
        guard let detail, !detail.isEmpty, kind != "summary" else { return nil }
        let text = clean(detail)
        guard !text.isEmpty else { return nil }
        return kind == "message" ? "“\(text)”" : text
    }

    /// Activity as lists show it, newest first in and out (fleet-view.ts `visibleActivity`).
    /// `summary` events are hidden: the latest summary is the bot's one line instead. Back-to-back
    /// events from one bot with the same text become one row: the newest, or the status when a
    /// message copy repeats it.
    static func visibleActivity(_ items: [ActivityItem]) -> [ActivityItem] {
        var out: [ActivityItem] = []
        // True once the last kept row has absorbed an older repeat; then it stays as is.
        var merged = false
        for item in items where item.kind != "summary" {
            if let prev = out.last, prev.account == item.account, prev.botId == item.botId,
               item.detail != nil ? prev.detail == item.detail : (prev.detail == nil && prev.kind == item.kind) {
                if !merged && prev.kind == "message" && (item.kind == "waiting_user" || item.kind == "error") {
                    out[out.count - 1] = item
                }
                merged = true
                continue
            }
            out.append(item)
            merged = false
        }
        return out
    }

    static func activityTone(kind: String) -> Tone {
        switch kind {
        case "waiting_user", "message": return .amber
        case "working": return .blue
        case "error": return .red
        case "summary", "avi_replied", "saved", "unsaved": return .violet
        default: return .gray
        }
    }
}

/// Colour families. Theme.swift maps each to a foreground, tint and fill.
enum Tone: Hashable {
    case red, amber, pink, blue, green, violet, gray, sky, indigo
}

/// Wall-clock times are shown in Asia/Hebron, the same as the web dashboard.
enum Fmt {
    static let zone = TimeZone(identifier: "Asia/Hebron") ?? .current

    private static func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = zone
        f.dateFormat = format
        return f
    }

    private static let clockFmt = formatter("h:mm a")
    private static let dayKeyFmt = formatter("yyyy-MM-dd")
    private static let shortDateFmt = formatter("MMM d")
    private static let weekdayFmt = formatter("EEE")
    private static let fullFmt = formatter("EEE, MMM d, h:mm a")
    private static let dayLabelFmt = formatter("EEE, MMM d")

    static func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

    static func isSameDay(_ a: Double, _ b: Double) -> Bool {
        dayKeyFmt.string(from: date(a)) == dayKeyFmt.string(from: date(b))
    }

    /// "8:02 PM".
    static func clock(_ at: Double) -> String { clockFmt.string(from: date(at)) }

    /// "8:02 PM" today, otherwise "Nov 23, 8:02 PM".
    static func clockOrDate(_ at: Double, now: Double) -> String {
        isSameDay(at, now) ? clock(at) : "\(shortDateFmt.string(from: date(at))), \(clock(at))"
    }

    /// "Tue, Nov 24, 8:02 PM".
    static func full(_ at: Double) -> String { fullFmt.string(from: date(at)) }

    /// "now", "14m", "3h", "2d". Future times read as "now".
    static func age(_ at: Double, now: Double) -> String {
        let seconds = (now - at) / 1000
        if seconds < 45 { return "now" }
        let minutes = max(1, Int((seconds / 60).rounded()))
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        return "\(hours / 24)d"
    }

    /// "14m", "3h", "2d" (at least 1m).
    static func duration(_ ms: Double) -> String {
        let minutes = max(1, Int((ms / 60_000).rounded(.down)))
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        return "\(hours / 24)d"
    }

    /// Reset label: a clock today, a weekday within a week, otherwise "Dec 1".
    static func reset(_ at: Double, now: Double) -> String {
        if isSameDay(at, now) { return clock(at) }
        let days = ((at - now) / 86_400_000).rounded()
        if days >= -1 && days <= 6 { return weekdayFmt.string(from: date(at)) }
        return shortDateFmt.string(from: date(at))
    }

    /// "1:53 PM" today, "Wed 1:53 PM" within the last week, otherwise "Nov 23, 1:53 PM".
    static func pastClock(_ at: Double, now: Double) -> String {
        if isSameDay(at, now) { return clock(at) }
        if now - at < 6 * 86_400_000 { return "\(weekdayFmt.string(from: date(at))) \(clock(at))" }
        return "\(shortDateFmt.string(from: date(at))), \(clock(at))"
    }

    /// "11h ago", or "just now".
    static func ago(_ at: Double, now: Double) -> String {
        let short = Self.age(at, now: now)
        return short == "now" ? "just now" : "\(short) ago"
    }

    /// A past time: a clock today, a weekday within the last week, otherwise "Nov 23".
    static func pastDay(_ at: Double, now: Double) -> String {
        if isSameDay(at, now) { return clock(at) }
        if now - at < 6 * 86_400_000 { return weekdayFmt.string(from: date(at)) }
        return shortDateFmt.string(from: date(at))
    }

    /// "12:49 PM (Hebron)".
    static func headerClock(_ now: Double) -> String { "\(clock(now)) (Hebron)" }

    /// Feed section for an item: "Now" (last 15 minutes), "Earlier today", "Yesterday", or "Mon, Nov 23".
    static func feedSection(_ at: Double, now: Double) -> String {
        if now - at < 15 * 60_000 { return "Now" }
        if isSameDay(at, now) { return "Earlier today" }
        if isSameDay(at, now - 86_400_000) { return "Yesterday" }
        return dayLabelFmt.string(from: date(at))
    }

    static func percent(_ value: Double) -> String { "\(Int(value.rounded()))%" }

    /// "5h 32m", "31m", "1d 3h", or "<1m".
    static func hoursMinutes(_ ms: Double) -> String {
        let minutes = Int((max(0, ms) / 60_000).rounded(.down))
        if minutes < 1 { return "<1m" }
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return minutes % 60 == 0 ? "\(hours)h" : "\(hours)h \(minutes % 60)m" }
        return hours % 24 == 0 ? "\(hours / 24)d" : "\(hours / 24)d \(hours % 24)h"
    }
}
