import Foundation

// GET /api/v1/state, decoded natively. Shapes follow src/shared/model.ts (StateResponse) and
// docs/SESSIONS-API.md. Times are Unix milliseconds. Collector-owned enums (tool, status,
// group, meter state) stay strings so a new value never blanks the window.

enum FleetAccount: String, Decodable, CaseIterable, Hashable {
    case work, leaf

    /// Names the UI uses. Internal ids stay `work` and `leaf`.
    var label: String { self == .work ? "Avi's Work" : "Admin" }
}

struct FleetState: Decodable {
    var version: Int
    /// Server clock (ms) when the response was built.
    var now: Double
    var staleAfterMs: Double
    /// Needs-my-attention bots across both accounts. Saved bots and coding sessions are never here.
    var attention: [AttentionItem]
    var bots: [Bot]
    var sessions: [CodingSession]
    var accounts: [UsageAccount]
    var grok: [GrokUsage]
    /// First activity page, newest first.
    var activity: [ActivityItem]

    private enum Keys: String, CodingKey {
        case version, now, staleAfterMs, attention, bots, sessions, accounts, grok, activity
    }

    private struct ActivityPage: Decodable {
        var items: [ActivityItem]?
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 0
        now = try c.decode(Double.self, forKey: .now)
        staleAfterMs = try c.decodeIfPresent(Double.self, forKey: .staleAfterMs) ?? 600_000
        attention = try c.decodeIfPresent([AttentionItem].self, forKey: .attention) ?? []
        bots = try c.decodeIfPresent([Bot].self, forKey: .bots) ?? []
        // Collector-owned sections: one that does not decode shows as empty instead of
        // failing the whole reply, so the attention count and the bots keep working.
        sessions = (try? c.decodeIfPresent([CodingSession].self, forKey: .sessions)) ?? []
        accounts = (try? c.decodeIfPresent([UsageAccount].self, forKey: .accounts)) ?? []
        grok = (try? c.decodeIfPresent([GrokUsage].self, forKey: .grok)) ?? []
        activity = (try? c.decodeIfPresent(ActivityPage.self, forKey: .activity))?.items ?? []
    }
}

/// One bot that needs Avi (`state` is waiting_user, error or stale).
struct AttentionItem: Decodable, Hashable {
    var account: FleetAccount
    var accountLabel: String
    var id: String
    var name: String
    var group: String
    var state: String
    var step: String?
    var statusAt: Double?

    var key: String { "\(account.rawValue):\(id)" }
}

/// A Grok bot. `id` is the bot UUID; the same id can exist in both accounts, so lists use `key`.
struct Bot: Decodable, Hashable {
    var account: FleetAccount
    var id: String
    var name: String
    var group: String
    var sortIndex: Double
    /// waiting_user, working, idle or error. Null until the first report.
    var status: String?
    var step: String?
    var statusAt: Double?
    var summaryAt: Double?
    /// Message copies received since Avi's last reply.
    var unread: Int
    var lastAviReplyAt: Double?
    var lastReportAt: Double?
    /// When it was put in Save for later; null when it is not saved.
    var savedAt: Double?
    /// Its look in the Grok Bot app; null when never set.
    var avatar: BotAvatar?

    var key: String { "\(account.rawValue):\(id)" }
}

/// `{shape, color}` from the bot's Grok Bot profile. Kept as strings: an unknown value draws the
/// initials fallback instead of failing the whole reply.
struct BotAvatar: Decodable, Hashable {
    var shape: String?
    var color: String?

    private enum Keys: String, CodingKey { case shape, color }

    init(shape: String?, color: String?) {
        self.shape = shape
        self.color = color
    }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: Keys.self) else { return }
        shape = try? c.decodeIfPresent(String.self, forKey: .shape)
        color = try? c.decodeIfPresent(String.self, forKey: .color)
    }
}

struct ActivityItem: Decodable, Hashable {
    var seq: Int
    var at: Double
    var account: FleetAccount
    var botId: String
    var botName: String
    /// working, waiting_user, error, idle, done, summary, message, avi_replied, saved, unsaved.
    var kind: String
    var detail: String?

    var botKey: String { "\(account.rawValue):\(botId)" }
}

struct SessionHelper: Decodable, Hashable {
    var name: String
    var status: String
    var step: Int?
    var steps: Int?
    var runtimeSec: Int?
}

struct SessionCI: Decodable, Hashable {
    var state: String
    var url: String?
}

/// A coding session from the box collector. FYI only: never a bot, never Needs my attention.
/// `account` is the tool source (claudeMax, claudeAdmin, cursor, …), not a Grok account.
struct CodingSession: Decodable, Hashable {
    var id: String
    var tool: String?
    var title: String
    var status: String
    var step: Int?
    var steps: Int?
    var helpers: [SessionHelper]?
    var startedAt: Double
    var updatedAt: Double
    var finishedAt: Double?
    var limitReset: Double?
    var ownerBotId: String?
    var ownerName: String?
    var account: String
    var prUrl: String?
    var ci: SessionCI?
    var repo: String?
    var branch: String?
    var agentUrl: String?
    var model: String?
    var effort: String?
    var alive: Bool
    var lastSeenAt: Double?
    /// paused_limit, stalled or pr_ready. A badge on the session row only.
    var attentionReason: String?

    var helperList: [SessionHelper] { helpers ?? [] }
}

struct UsageMeter: Decodable, Hashable {
    var id: String
    var label: String
    var pctUsed: Double?
    var resetAt: Double?
    /// ok (default) or no_limit.
    var state: String?

    var noLimit: Bool { state == "no_limit" }
}

/// Dollars as a number (`{"amount": 41}`) or a string the collector already formatted (`{"text": "…"}`).
struct Money: Decodable, Hashable {
    var amount: Double?
    var text: String?
}

/// A Claude account, Cursor, Codex, or an API pool (`group` = claude, cursor, codex, api).
struct UsageAccount: Decodable, Hashable {
    var id: String
    var label: String
    var group: String
    var parentId: String?
    var meters: [UsageMeter]
    var spend: Money?
    var remaining: Money?
    var granted: Money?
    var expiresAt: Double?
    var verified: String?
    var routingVerified: Bool?
    var note: String?
    var reportedAt: Double?
}

struct GrokBotUsage: Decodable, Hashable {
    var botId: String
    var name: String
    /// Share of this account's Grok usage, 0–100.
    var share: Double
    /// Part of `share` that is routines, 0–100, or null.
    var routinesShare: Double?
}

struct GrokUsage: Decodable, Hashable {
    var account: FleetAccount
    var pctUsed: Double
    var resetAt: Double?
    var reportedAt: Double?
    /// When the numbers were read from Grok Bot's usage report. Older servers send only `reportedAt`.
    var asOf: Double?
    var bots: [GrokBotUsage]

    var readAt: Double? { asOf ?? reportedAt }
}
