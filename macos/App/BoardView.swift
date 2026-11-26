import SwiftUI

/// Board tab: one kanban column per bot status, using the server's partition (Needs me, Working,
/// Saved for later, Idle & done). Actions open a chat or a PR, or (with a control key) Later / Move back.
struct BoardView: View {
    @ObservedObject var model: FleetModel
    let d: FleetDerived
    @Environment(\.widthClass) private var widthClass

    private static let pad: CGFloat = 16
    private static let gap: CGFloat = 14

    var body: some View {
        if widthClass == .narrow {
            stacked
        } else {
            sideBySide
        }
    }

    /// Narrow: one scroll of full-width sections.
    private var stacked: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: Self.gap) {
                needsColumn(scrolls: false, perRow: 1)
                workingColumn(scrolls: false, perRow: 2, compact: true)
                savedColumn(scrolls: false)
                idleColumn(scrolls: false, chips: true)
            }
            .padding(Self.pad)
        }
    }

    /// Regular and wide: four columns that scroll on their own. Wide windows give Needs me and
    /// Working double width with two cards per row (widths 2.3 : 2 : 1.2 : 1).
    private var sideBySide: some View {
        GeometryReader { geo in
            let wide = widthClass == .wide
            let ratios: [CGFloat] = wide ? [2.3, 2, 1.2, 1] : [1, 1, 1, 1]
            let total: CGFloat = ratios.reduce(0, +)
            let unit: CGFloat = max(0, geo.size.width - 2 * Self.pad - 3 * Self.gap) / total
            HStack(alignment: .top, spacing: Self.gap) {
                needsColumn(scrolls: true, perRow: wide ? 2 : 1).frame(width: unit * ratios[0])
                workingColumn(scrolls: true, perRow: wide ? 2 : 1, compact: false).frame(width: unit * ratios[1])
                savedColumn(scrolls: true).frame(width: unit * ratios[2])
                idleColumn(scrolls: true, chips: false).frame(width: unit * ratios[3])
            }
            .padding(Self.pad)
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
        }
    }

    // MARK: Columns

    private func needsColumn(scrolls: Bool, perRow: Int) -> some View {
        BoardColumn(.needs, count: d.attention.count, byAccount: grouped(d.attention), scrolls: scrolls) {
            cards(d.attention, lane: .needs, perRow: perRow) { row in
                BoardNeedsCard(model: model, row: row, d: d, onFocus: { model.focus(on: row.key) })
            }
        }
    }

    private func workingColumn(scrolls: Bool, perRow: Int, compact: Bool) -> some View {
        BoardColumn(.working, count: d.working.count, byAccount: grouped(d.working), scrolls: scrolls) {
            cards(d.working, lane: .working, perRow: perRow) { row in
                BoardWorkingCard(row: row, d: d, compact: compact)
            }
        }
    }

    private func savedColumn(scrolls: Bool) -> some View {
        BoardColumn(.saved, count: d.saved.count, byAccount: grouped(d.saved), scrolls: scrolls) {
            cards(d.saved, lane: .saved, perRow: 1) { row in
                BoardSavedCard(model: model, row: row, now: d.now)
            }
        }
    }

    private func idleColumn(scrolls: Bool, chips: Bool) -> some View {
        BoardColumn(.idle, count: d.idle.count, byAccount: !chips && grouped(d.idle), scrolls: scrolls) {
            BoardIdleList(d: d, chips: chips)
        }
    }

    /// Cards split by account when needed, one per row or in a grid; the lane's empty text when none.
    @ViewBuilder
    private func cards<Card: View>(_ rows: [BotRow], lane: BoardLane, perRow: Int,
                                   @ViewBuilder card: @escaping (BotRow) -> Card) -> some View {
        if rows.isEmpty { BoardEmpty(text: lane.empty) }
        ForEach(BoardSection.split(rows, filter: d.filter), id: \.id) { section in
            if let account = section.account { BoardSubheader(account: account) }
            if perRow > 1 {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10, alignment: .top), count: perRow),
                          alignment: .leading, spacing: 10) {
                    ForEach(section.rows, id: \.key) { row in card(row) }
                }
            } else {
                ForEach(section.rows, id: \.key) { row in card(row) }
            }
        }
    }

    private func grouped(_ rows: [BotRow]) -> Bool { BoardSection.grouped(rows, filter: d.filter) }
}

// MARK: Column pieces

/// A column's title, header colour and empty text.
private struct BoardLane {
    let title: String
    let tone: Tone
    let empty: String

    static let needs = BoardLane(title: "Needs me", tone: .red, empty: "Nothing needs you")
    static let working = BoardLane(title: "Working", tone: .blue, empty: "No bot is working")
    static let saved = BoardLane(title: "Saved for later", tone: .violet, empty: "Nothing saved for later")
    static let idle = BoardLane(title: "Idle & done", tone: .gray, empty: "No idle bots")
}

/// Rows of one account (labelled) or all rows (unlabelled).
private struct BoardSection {
    let account: FleetAccount?
    let rows: [BotRow]
    var id: String { account?.rawValue ?? "all" }

    /// Under All, when the rows span both accounts: labelled by account.
    static func grouped(_ rows: [BotRow], filter: AccountFilter) -> Bool {
        filter == .all && Set(rows.map(\.account)).count > 1
    }

    /// Avi's Work first, then Admin, when grouped; otherwise one unlabelled section.
    static func split(_ rows: [BotRow], filter: AccountFilter) -> [BoardSection] {
        guard grouped(rows, filter: filter) else { return [BoardSection(account: nil, rows: rows)] }
        return FleetAccount.allCases.map { account in
            BoardSection(account: account, rows: rows.filter { $0.account == account })
        }
    }
}

/// Grey rounded column: coloured square, title, count and "by account", then its content.
/// `scrolls` keeps the header fixed and scrolls the content inside the column.
private struct BoardColumn<Content: View>: View {
    let lane: BoardLane
    let count: Int
    let byAccount: Bool
    let scrolls: Bool
    let content: Content

    init(_ lane: BoardLane, count: Int, byAccount: Bool, scrolls: Bool, @ViewBuilder content: () -> Content) {
        self.lane = lane
        self.count = count
        self.byAccount = byAccount
        self.scrolls = scrolls
        self.content = content()
    }

    var body: some View {
        if scrolls {
            VStack(alignment: .leading, spacing: 0) {
                header.padding(EdgeInsets(top: 12, leading: 12, bottom: 10, trailing: 12))
                ScrollView(.vertical) {
                    stack.padding([.horizontal, .bottom], 12)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(RoundedRectangle(cornerRadius: 16).fill(Theme.column))
            .clipShape(RoundedRectangle(cornerRadius: 16))
        } else {
            VStack(alignment: .leading, spacing: 10) { header; stack }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 16).fill(Theme.column))
        }
    }

    private var stack: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var header: some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 3).fill(Theme.fill(lane.tone)).frame(width: 10, height: 10)
            Text(lane.title).font(Theme.F.title).foregroundStyle(Theme.text).lineLimit(1).layoutPriority(1)
            Text("\(count)").font(Theme.F.smallBold).monospacedDigit().foregroundStyle(Theme.text2)
                .padding(.horizontal, 7).padding(.vertical, 1)
                .background(Capsule().fill(Theme.surface))
                .fixedSize()
            Spacer(minLength: 6)
            if byAccount {
                Text("by account").font(Theme.F.caption).foregroundStyle(Theme.text3).lineLimit(1)
            }
        }
    }
}

/// "AVI'S WORK ───" inside a column; with `text`, a grey label after it ("IDLE", "DONE TODAY").
private struct BoardSubheader: View {
    var account: FleetAccount?
    var text: String?

    var body: some View {
        HStack(spacing: 6) {
            if let account {
                Text(account.label.uppercased()).font(Theme.F.label).tracking(0.5)
                    .foregroundStyle(Theme.fg(Theme.accountTone(account))).lineLimit(1)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Theme.tint(Theme.accountTone(account))))
                    .fixedSize()
            }
            if let text { SectionLabel(text: text).fixedSize() }
            Rectangle().fill(Theme.line).frame(height: 1)
        }
        .padding(.top, 2)
    }
}

private struct BoardEmpty: View {
    let text: String
    var body: some View {
        Text(text).font(Theme.F.caption).foregroundStyle(Theme.text3).multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 18)
    }
}

// MARK: Cards

/// "PMS  [Avi's Work]".
private struct BoardGroupLine: View {
    let row: BotRow
    var body: some View {
        HStack(spacing: 6) {
            Text(Rules.groupName(row.bot.group).uppercased()).font(Theme.F.label).tracking(0.4)
                .foregroundStyle(Theme.text3).lineLimit(1)
            AccountTag(account: row.account)
        }
    }
}

/// Small grey age or time at the end of a card's title line.
private struct BoardTime: View {
    let text: String
    var body: some View {
        Text(text).font(Theme.F.small).monospacedDigit().foregroundStyle(Theme.text3).lineLimit(1).fixedSize()
    }
}

/// Needs me / Stuck / Stale. Clicking the name shows the bot in Focus.
private struct BoardNeedsCard: View {
    @ObservedObject var model: FleetModel
    let row: BotRow
    let d: FleetDerived
    let onFocus: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            BoardGroupLine(row: row)
            HStack(spacing: 8) {
                BotSymbol(bot: row.bot)
                Button(action: onFocus) {
                    Text(row.bot.name).font(Theme.F.cardTitle).foregroundStyle(Theme.text).lineLimit(1)
                }
                .buttonStyle(PlainRowButtonStyle())
                .help("Show \(row.bot.name) in Focus")
                .layoutPriority(1)
                StateBadge(row: row, now: d.now)
                Spacer(minLength: 6)
                if let at = Rules.lastSeenAt(row.bot) { BoardTime(text: Fmt.age(at, now: d.now)) }
            }
            Text(row.step).font(Theme.F.body).foregroundStyle(Theme.text2).lineLimit(2)
            FlowLayout(spacing: 6).callAsFunction {
                OpenChatButton(bot: row.bot, compact: true)
                if let pr = prURL {
                    LinkButton(title: Sessions.prLabel(pr.absoluteString), url: pr, compact: true)
                }
                SaveForLaterButton(model: model, bot: row.bot)
            }
            .padding(.top, 4)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(edge: row.state.tone)
    }

    /// The first https pull-request link among the sessions this bot started.
    private var prURL: URL? {
        d.sessions(for: row.bot).compactMap { Sessions.safeURL($0.prUrl) }.first
    }
}

/// Working bot. `compact` (narrow grid) keeps only name, age and a one-line step.
private struct BoardWorkingCard: View {
    let row: BotRow
    let d: FleetDerived
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 3 : 5) {
            if !compact { BoardGroupLine(row: row) }
            HStack(spacing: 8) {
                BotSymbol(bot: row.bot)
                Text(row.bot.name).font(Theme.F.cardTitle).foregroundStyle(Theme.text).lineLimit(1)
                Spacer(minLength: 6)
                if let at = Rules.lastSeenAt(row.bot) { BoardTime(text: Fmt.age(at, now: d.now)) }
            }
            Text(row.step).font(compact ? Theme.F.small : Theme.F.body).foregroundStyle(Theme.text2)
                .lineLimit(compact ? 1 : 2)
            if !compact, let note = Sessions.codingNote(d.sessions(for: row.bot)) {
                HStack(spacing: 4) { Image(systemName: "keyboard"); Text(note).lineLimit(1) }
                    .font(Theme.F.caption)
                    .foregroundStyle(Theme.text3)
            }
        }
        .padding(compact ? 10 : 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(edge: .blue)
        .help(row.step)
    }
}

/// Saved for later, with Move back when Settings has a control key.
private struct BoardSavedCard: View {
    @ObservedObject var model: FleetModel
    let row: BotRow
    let now: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            BoardGroupLine(row: row)
            HStack(spacing: 8) {
                BotSymbol(bot: row.bot)
                Text(row.bot.name).font(Theme.F.cardTitle).foregroundStyle(Theme.text).lineLimit(1)
                Pill(text: "Saved", tone: .violet, uppercase: true)
                Spacer(minLength: 6)
                if let at = row.bot.savedAt { BoardTime(text: Fmt.clockOrDate(at, now: now)) }
            }
            Text(row.step).font(Theme.F.body).foregroundStyle(Theme.text2).lineLimit(2)
            FlowLayout(spacing: 6).callAsFunction {
                OpenChatButton(bot: row.bot, compact: true)
                SaveForLaterButton(model: model, bot: row.bot)
            }
            .padding(.top, 4)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(edge: .violet)
    }
}

// MARK: Idle & done

/// Bots that finished today first (green dot), then the rest, by account under All. Rows in a
/// column, or chips in a flow on narrow windows. Shows 14, then "+N more" expands in place.
private struct BoardIdleList: View {
    let d: FleetDerived
    let chips: Bool
    @State private var expanded = false

    private static let limit = 14

    var body: some View {
        let done = doneToday
        let ordered = d.idle.filter { done.contains($0.key) } + d.idle.filter { !done.contains($0.key) }
        let shown = expanded ? ordered : Array(ordered.prefix(Self.limit))
        let doneShown = shown.filter { done.contains($0.key) }
        let rest = shown.filter { !done.contains($0.key) }
        if ordered.isEmpty {
            BoardEmpty(text: BoardLane.idle.empty)
        } else if chips {
            FlowLayout(spacing: 6, lineSpacing: 6).callAsFunction {
                ForEach(shown, id: \.key) { row in item(row, done: done.contains(row.key)) }
                moreButton(total: ordered.count)
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if !doneShown.isEmpty {
                    BoardSubheader(text: "Done today")
                    ForEach(doneShown, id: \.key) { row in item(row, done: true) }
                }
                ForEach(BoardSection.split(rest, filter: d.filter), id: \.id) { section in
                    if !section.rows.isEmpty && (section.account != nil || !doneShown.isEmpty) {
                        BoardSubheader(account: section.account, text: "Idle")
                    }
                    ForEach(section.rows, id: \.key) { row in item(row, done: false) }
                }
                moreButton(total: ordered.count)
            }
        }
    }

    /// Bots with a "done" activity item today (Hebron day).
    private var doneToday: Set<String> {
        Set(d.activity.filter { $0.kind == "done" && Fmt.isSameDay($0.at, d.now) }.map(\.botKey))
    }

    private func item(_ row: BotRow, done: Bool) -> some View {
        cell(row.bot.name, trailing: day(row), tone: done ? .green : .gray).help(row.step)
    }

    /// Last sign of life as a clock, weekday or date; "No status yet" for a bot that never reported.
    private func day(_ row: BotRow) -> String {
        guard row.state != .unknown, let seen = Rules.lastSeenAt(row.bot) else { return "No status yet" }
        return Fmt.pastDay(seen, now: d.now)
    }

    @ViewBuilder
    private func moreButton(total: Int) -> some View {
        if total > Self.limit {
            Button { expanded.toggle() } label: {
                cell(expanded ? "Show fewer" : "+\(total - Self.limit) more", trailing: nil, tone: .gray)
            }
            .buttonStyle(PlainRowButtonStyle())
        }
    }

    /// Dot, name and a grey day: a 30pt row, or a capsule chip.
    @ViewBuilder
    private func cell(_ name: String, trailing: String?, tone: Tone) -> some View {
        let label = HStack(spacing: 7) {
            Dot(tone: tone, size: 7)
            Text(name).font(Theme.F.body).foregroundStyle(Theme.text).lineLimit(1)
            if !chips { Spacer(minLength: 6) }
            if let trailing {
                Text(trailing).font(Theme.F.caption).foregroundStyle(Theme.text3).lineLimit(1).fixedSize()
            }
        }
        if chips {
            label.padding(.horizontal, 10).padding(.vertical, 6).background(Capsule().fill(Theme.surface))
        } else {
            label.padding(.horizontal, 10)
                .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface))
        }
    }
}
