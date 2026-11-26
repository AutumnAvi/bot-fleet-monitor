import AppKit
import SwiftUI

/// The main view. Accounts full width; then coding sessions | recently used side by side, or one
/// column when the window is narrow (under 900 points).
struct MonitorView: View {
    @ObservedObject var model: FleetModel
    let d: FleetDerived
    let state: FleetState

    @Environment(\.widthClass) private var width
    @State private var showAllBots = false

    private var narrow: Bool { width == .narrow }
    private var pad: CGFloat { narrow ? 12 : 18 }

    var body: some View {
        let cards = MonitorRules.accounts(state, now: d.now)
        let sessions = MonitorRules.sessions(d)
        let bots = MonitorRules.recentBots(d)
        if narrow {
            ScrollView {
                VStack(spacing: 12) {
                    AccountsPanel(cards: cards, now: d.now)
                    MonitorPanel(title: "Coding sessions", meta: sessionMeta(sessions)) { sessionRows(sessions) }
                    MonitorPanel(title: "Recently used", meta: recentMeta(bots)) { botRows(bots) }
                }
                .padding(pad)
            }
        } else {
            VStack(spacing: 14) {
                AccountsPanel(cards: cards, now: d.now)
                HStack(alignment: .top, spacing: 14) {
                    MonitorPanel(title: "Coding sessions", meta: sessionMeta(sessions), fills: true) {
                        ScrollView { sessionRows(sessions) }
                    }
                    MonitorPanel(title: "Recently used", meta: recentMeta(bots), fills: true) {
                        ScrollView { botRows(bots) }
                    }
                }
                .frame(maxHeight: .infinity)
            }
            .padding(pad)
        }
    }

    // MARK: Coding sessions

    private func sessionMeta(_ sessions: [CodingSession]) -> Text {
        let live = sessions.filter(Sessions.isLive).count
        let rest = sessions.count - live
        if sessions.isEmpty { return Text("none in the last 24 hours") }
        let ended = Text(rest > 0 ? " · \(rest) more in the last 24 hours" : "")
        return Text("\(live) live").fontWeight(.semibold).foregroundStyle(live > 0 ? Theme.fg(.green) : Theme.text2) + ended
    }

    @ViewBuilder private func sessionRows(_ sessions: [CodingSession]) -> some View {
        if sessions.isEmpty {
            empty("No coding sessions in the last 24 hours.")
        } else {
            VStack(spacing: 0) {
                ForEach(Array(sessions.enumerated()), id: \.element.id) { index, session in
                    if index > 0 { Rectangle().fill(Theme.line).frame(height: 1) }
                    MonitorSessionRow(session: session, owner: MonitorRules.shortName(d.ownerName(of: session)),
                                      now: d.now)
                }
            }
        }
    }

    // MARK: Recently used

    private func recentMeta(_ bots: [RecentBot]) -> Text {
        let need = bots.filter(\.needsYou).count
        let sorted = Text("sorted by last activity")
        guard need > 0 else { return sorted }
        return Text(need == 1 ? "1 needs you" : "\(need) need you").fontWeight(.semibold)
            .foregroundStyle(Theme.fg(.amber)) + Text(" · ") + sorted
    }

    @ViewBuilder private func botRows(_ bots: [RecentBot]) -> some View {
        if bots.isEmpty {
            empty("No bot has reported in the last week.")
        } else {
            let shown = showAllBots ? bots : Array(bots.prefix(MonitorRules.recentLimit))
            VStack(spacing: 0) {
                ForEach(Array(shown.enumerated()), id: \.element.key) { index, bot in
                    if index > 0 { Rectangle().fill(Theme.line).frame(height: 1) }
                    RecentBotRow(model: model, item: bot, now: d.now)
                }
                if bots.count > MonitorRules.recentLimit {
                    Rectangle().fill(Theme.line).frame(height: 1)
                    Button(showAllBots ? "Show fewer" : "Show \(bots.count - shown.count) more") { showAllBots.toggle() }
                        .buttonStyle(PlainRowButtonStyle())
                        .font(Theme.F.smallBold).foregroundStyle(Theme.text2)
                        .frame(maxWidth: .infinity, minHeight: 34)
                }
            }
        }
    }

    private func empty(_ text: String) -> some View {
        Text(text).font(Theme.F.small).foregroundStyle(Theme.text3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16).padding(.vertical, 14)
    }
}

/// White card with an uppercase title, a right-aligned note, and its rows.
private struct MonitorPanel<Content: View>: View {
    let title: String
    let meta: Text
    var fills = false
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                SectionLabel(text: title).layoutPriority(1)
                Spacer(minLength: 8)
                meta.font(Theme.F.small).foregroundStyle(Theme.text3).lineLimit(1)
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            Rectangle().fill(Theme.line).frame(height: 1)
            content()
            if fills { Spacer(minLength: 0) }
        }
        .frame(maxWidth: .infinity, maxHeight: fills ? CGFloat.infinity : nil, alignment: .top)
        .card()
    }
}

// MARK: Accounts

/// Main Claude, Admin Claude, Cursor, Codex and Grok, each with a signal chip and its reset.
struct AccountsPanel: View {
    let cards: [AccountCard]
    let now: Double
    @Environment(\.widthClass) private var width

    var body: some View {
        MonitorPanel(title: "Accounts", meta: meta) {
            if cards.isEmpty {
                Text("No usage pushed yet.").font(Theme.F.small).foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.vertical, 14)
            } else if width == .narrow {
                VStack(spacing: 0) {
                    ForEach(Array(cards.enumerated()), id: \.element.kind) { index, card in
                        if index > 0 { Rectangle().fill(Theme.line).frame(height: 1) }
                        AccountTile(card: card, now: now, row: true)
                    }
                }
            } else {
                HStack(spacing: 0) {
                    ForEach(Array(cards.enumerated()), id: \.element.kind) { index, card in
                        if index > 0 { Rectangle().fill(Theme.line).frame(width: 1) }
                        AccountTile(card: card, now: now, row: false)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var meta: Text {
        let text = MonitorRules.headerText(cards)
        let worst = cards.map(\.signal).max() ?? .ok
        return worst == .ok ? Text(text) : Text(text).fontWeight(.semibold).foregroundStyle(Theme.fg(worst.tone))
    }
}

/// One account. `row` lays it out as a full-width row (narrow windows) with the bars on the right.
private struct AccountTile: View {
    let card: AccountCard
    let now: Double
    let row: Bool

    var body: some View {
        Group {
            if row {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) { title; useFirst }
                        numbers
                        details
                    }
                    Spacer(minLength: 8)
                    VStack(alignment: .trailing, spacing: 8) {
                        SignalChip(signal: card.signal)
                        labelledBars.frame(width: 150)
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    // Use first drops under the name when the tile is too narrow for both.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 6) {
                            title.fixedSize()
                            useFirst
                            Spacer(minLength: 4)
                            SignalChip(signal: card.signal)
                        }
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                title
                                Spacer(minLength: 4)
                                SignalChip(signal: card.signal)
                            }
                            useFirst
                        }
                    }
                    numbers
                    details
                    Spacer(minLength: 8)
                    bars
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .help(tooltip)
    }

    private var title: some View {
        Text(card.name.uppercased()).font(.system(size: 12, weight: .semibold)).tracking(0.4)
            .foregroundStyle(Theme.text).lineLimit(1)
    }

    @ViewBuilder private var useFirst: some View {
        if card.useFirst { Pill(text: "Use first", tone: .indigo, uppercase: true) }
    }

    /// "6% weekly", or Cursor's "3.9% Models   22.9% Other".
    private var numbers: some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            ForEach(Array(card.headline.enumerated()), id: \.offset) { _, meter in
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(meter.used.map(MonitorRules.pct) ?? (meter.noLimit ? "No limit" : "–"))
                        .font(.system(size: 24, weight: .bold)).monospacedDigit()
                        .foregroundStyle(meter.signal == .ok ? Theme.text : Theme.fg(meter.signal.tone))
                        .lineLimit(1).minimumScaleFactor(0.7)
                    Text(meter.label == "Weekly" ? "weekly" : meter.label).font(Theme.F.small)
                        .foregroundStyle(Theme.text3).lineLimit(1)
                }
            }
        }
    }

    /// "Weekly 37%", "5-hour no limit", then "Resets Fri 6:00 PM".
    @ViewBuilder private var details: some View {
        ForEach(Array(card.others.enumerated()), id: \.offset) { _, meter in
            (Text(meter.label).fontWeight(.medium).foregroundStyle(Theme.text2)
             + Text(" " + (meter.noLimit ? "no limit" : meter.used.map(MonitorRules.pct) ?? "–"))
                .foregroundStyle(meter.signal == .ok ? Theme.text3 : Theme.fg(meter.signal.tone)))
                .font(Theme.F.small).lineLimit(1)
        }
        if let reset = card.resetAt {
            (Text("Resets").fontWeight(.medium).foregroundStyle(Theme.text2)
             + Text(" " + MonitorRules.resetText(reset, now: now)).foregroundStyle(Theme.text3))
                .font(Theme.F.small).lineLimit(1)
        }
    }

    /// One thin bar per meter with a number.
    private var bars: some View {
        VStack(spacing: 4) {
            ForEach(Array(barMeters.enumerated()), id: \.offset) { _, meter in
                Bar(fraction: (meter.used ?? 0) / 100, tone: barTone(meter), height: 4)
            }
        }
    }

    private var labelledBars: some View {
        VStack(alignment: .trailing, spacing: 6) {
            ForEach(Array(barMeters.enumerated()), id: \.offset) { _, meter in
                HStack(spacing: 8) {
                    Text(meter.label == "used" ? "Used" : meter.label).font(Theme.F.caption)
                        .foregroundStyle(Theme.text3).lineLimit(1).frame(width: 52, alignment: .leading)
                    Bar(fraction: (meter.used ?? 0) / 100, tone: barTone(meter), height: 4)
                }
            }
        }
    }

    private var barMeters: [MonitorMeter] { card.meters.filter { !$0.noLimit && $0.used != nil } }

    private func barTone(_ meter: MonitorMeter) -> Tone { meter.signal == .ok ? .indigo : meter.signal.tone }

    private var tooltip: String {
        let lines = card.meters.map { m -> String in
            let value = m.noLimit ? "no limit" : m.used.map { "\(MonitorRules.pct($0)) used" } ?? "–"
            let reset = m.resetAt.map { " · resets \(Fmt.full($0))" } ?? ""
            return "\(m.label == "used" ? "Used" : m.label): \(value)\(reset)"
        }
        return ([card.name + " · " + card.signal.label] + lines).joined(separator: "\n")
    }
}

/// OK, Near limit or Switch now.
struct SignalChip: View {
    let signal: UsageSignal
    var body: some View { Pill(text: signal.label, tone: signal.tone, uppercase: true) }
}

/// Slim red line under the top bar while any account is at Switch now. Its advice only ever
/// names Main Claude or Cursor.
struct SwitchBannerView: View {
    let banner: SwitchBanner

    var body: some View {
        HStack(spacing: 10) {
            Text("SWITCH NOW").font(.system(size: 10.5, weight: .bold)).tracking(0.3).foregroundStyle(.white)
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(Capsule().fill(Theme.fill(.red))).fixedSize()
            Text(banner.hot.joined(separator: "   ")).font(Theme.F.bodyBold).foregroundStyle(Theme.fg(.red))
                .lineLimit(1).truncationMode(.tail)
            if !banner.advice.isEmpty {
                Text(banner.advice).font(Theme.F.bodyBold).foregroundStyle(Theme.text).lineLimit(1).fixedSize()
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.tint(.red))
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.fill(.red).opacity(0.35)).frame(height: 1) }
        .help(banner.text)
        .accessibilityElement(children: .combine)
    }
}

// MARK: Rows

/// Tool, title, "started by <bot>", status, account and run time. Live is green; the rest is grey.
private struct MonitorSessionRow: View {
    let session: CodingSession
    let owner: String
    let now: Double
    @Environment(\.widthClass) private var width

    private var live: Bool { Sessions.isLive(session) }
    private var active: Bool { Sessions.isActive(session) }
    private var link: URL? { Sessions.safeURL(session.prUrl) ?? Sessions.safeURL(session.agentUrl) }

    var body: some View {
        if let link {
            Button { NSWorkspace.shared.open(link) } label: { content }
                .buttonStyle(PlainRowButtonStyle())
                .help("\(tooltip)\nClick to open \(link.host ?? "link")")
        } else {
            content.help(tooltip)
        }
    }

    private var content: some View {
        let tone = MonitorRules.sessionTone(session)
        return HStack(spacing: 10) {
            ToolBadge(session: session).opacity(active ? 1 : 0.55).frame(minWidth: 30, alignment: .leading).fixedSize()
            VStack(alignment: .leading, spacing: 1) {
                Text(Sessions.title(session, helpers: false)).font(active ? Theme.F.bodyBold : Theme.F.body)
                    .foregroundStyle(active ? Theme.text : Theme.text2).lineLimit(1).truncationMode(.tail)
                (Text("started by ").foregroundStyle(Theme.text3)
                 + Text(owner).fontWeight(.medium).foregroundStyle(active ? Theme.text2 : Theme.text3)
                 + Text(width == .narrow ? " · \(MonitorRules.poolName(session))" : "").foregroundStyle(Theme.text3))
                    .font(Theme.F.small).lineLimit(1)
            }
            .layoutPriority(1)
            Spacer(minLength: 6)
            Pill(text: Sessions.statusLabel(session), tone: tone, bold: live).opacity(active ? 1 : 0.8)
            if width != .narrow {
                Text(MonitorRules.poolName(session)).font(Theme.F.caption).foregroundStyle(Theme.text2).lineLimit(1)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Theme.line)).fixedSize()
            }
            Text(trailing).font(live ? Theme.F.bodyBold : Theme.F.small).monospacedDigit()
                .foregroundStyle(live ? Theme.fg(.green) : Theme.text3)
                .lineLimit(1).frame(minWidth: 58, alignment: .trailing).fixedSize()
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(live ? Theme.tint(.green).opacity(0.45) : Color.clear)
        .contentShape(Rectangle())
    }

    /// Run time, or "↻ 2:10 PM" for a session paused on a usage limit.
    private var trailing: String {
        if Sessions.displayStatus(session) == "paused_limit", let reset = session.limitReset {
            return "↻ \(Fmt.reset(reset, now: now))"
        }
        return MonitorRules.runtime(session, now: now)
    }

    private var tooltip: String {
        var parts = [Sessions.title(session), "\(Sessions.statusLabel(session)) · \(MonitorRules.poolName(session))"]
        if let repo = session.repo { parts.append(session.branch.map { "\(repo) · \($0)" } ?? repo) }
        if let model = session.model { parts.append(session.effort.map { "\(model) · \($0)" } ?? model) }
        return parts.joined(separator: "\n")
    }
}

/// Symbol (with a dot when the bot needs Avi), name, one line, status, unread count and age.
/// A needs-you row opens Focus on that bot.
private struct RecentBotRow: View {
    @ObservedObject var model: FleetModel
    let item: RecentBot
    let now: Double

    var body: some View {
        let bot = item.row.bot
        HStack(spacing: 10) {
            BotSymbol(bot: bot, size: 26)
                .overlay(alignment: .topTrailing) {
                    if item.needsYou {
                        Circle().fill(Theme.fill(item.row.state == .error ? .red : .amber))
                            .frame(width: 9, height: 9)
                            .overlay(Circle().strokeBorder(Theme.surface, lineWidth: 1.5))
                            .offset(x: 3, y: -3)
                            .help("Needs you")
                    }
                }
            VStack(alignment: .leading, spacing: 1) {
                Text(MonitorRules.shortName(bot.name)).font(Theme.F.bodyBold).foregroundStyle(Theme.text).lineLimit(1)
                Text(item.line).font(Theme.F.small).foregroundStyle(Theme.text2).lineLimit(1).truncationMode(.tail)
            }
            .layoutPriority(1)
            Spacer(minLength: 6)
            Pill(text: item.status, tone: item.tone, bold: true)
            if bot.unread > 0 {
                Text("\(bot.unread)").font(.system(size: 10.5, weight: .semibold)).monospacedDigit()
                    .foregroundStyle(Theme.text2).frame(minWidth: 18, minHeight: 18)
                    .background(Circle().fill(Theme.tint(.gray)))
                    .help(bot.unread == 1 ? "1 message since your last reply" : "\(bot.unread) messages since your last reply")
            }
            Text(Fmt.age(item.lastAt, now: now)).font(Theme.F.caption).monospacedDigit().foregroundStyle(Theme.text3)
                .lineLimit(1).frame(minWidth: 34, alignment: .trailing).fixedSize()
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture { if item.needsYou { model.focus(on: item.key) } }
        .help("\(bot.name) · \(bot.account.label)\n\(item.line)\nLast activity \(Fmt.full(item.lastAt))")
        .contextMenu {
            Button(Rules.openLabel(bot.account)) {
                if let url = Rules.openURL(botId: bot.id) { NSWorkspace.shared.open(url) }
            }
            if item.needsYou { Button("Show in Focus") { model.focus(on: item.key) } }
        }
    }
}
