import SwiftUI

/// Feed tab: what needs Avi pinned on top, saved bots, then the timeline of what bots pushed.
/// Regular and wide windows add a side column (working now, coding sessions, by account).
/// Read-only: the app's key can only read, so there is no Save for later or Move back here.
struct FeedView: View {
    @ObservedObject var model: FleetModel
    let d: FleetDerived

    @Environment(\.widthClass) private var widthClass
    @State private var chip: FeedChip = .everything

    @ViewBuilder var body: some View {
        if widthClass == .narrow {
            ScrollView {
                narrowColumn.padding(14).frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            HStack(alignment: .top, spacing: 0) {
                ScrollView {
                    mainColumn.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxWidth: .infinity)
                ScrollView {
                    sideColumn.padding(.vertical, 20).padding(.trailing, 20)
                }
                .frame(width: widthClass == .wide ? 440 : 380) // 420 / 360 of content plus the trailing pad
            }
        }
    }

    // MARK: Columns

    private var mainColumn: some View {
        VStack(alignment: .leading, spacing: 18) {
            attentionSection
            savedSection
            timelineSection
        }
    }

    private var sideColumn: some View {
        VStack(alignment: .leading, spacing: 14) {
            workingCard
            SessionsPanel(d: d, limit: 6)
            byAccountCard
        }
    }

    /// One column under 900pt: working bots become chips and sessions start folded.
    private var narrowColumn: some View {
        VStack(alignment: .leading, spacing: 16) {
            attentionSection
            savedSection
            workingChips
            SessionsPanel(d: d, limit: 4, startCollapsed: true)
            timelineSection
        }
    }

    // MARK: Needs my attention

    private var attentionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "pin.fill").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.fg(.red))
                SectionLabel(text: "Needs my attention · \(d.attention.count)")
                Spacer(minLength: 8)
                Text("pinned until handled").font(Theme.F.caption).foregroundStyle(Theme.text3).lineLimit(1)
            }
            if d.attention.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.fg(.green))
                    Text("Nothing needs you right now.").font(Theme.F.body).foregroundStyle(Theme.text2)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .card()
            } else {
                LazyVGrid(columns: attentionColumns, alignment: .leading, spacing: 10) {
                    ForEach(d.attention, id: \.key) { row in
                        FeedAttentionCard(row: row, now: d.now) { model.focus(on: row.key) }
                    }
                }
            }
        }
    }

    private var attentionColumns: [GridItem] {
        if widthClass == .narrow {
            return [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]
        }
        return [GridItem(.adaptive(minimum: 210), spacing: 10)]
    }

    // MARK: Saved for later

    @ViewBuilder private var savedSection: some View {
        if !d.saved.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(d.saved.prefix(3)), id: \.key) { row in
                    FeedSavedStrip(row: row, now: d.now)
                }
                if d.saved.count > 3 {
                    Text("+\(d.saved.count - 3) more saved").font(Theme.F.caption).foregroundStyle(Theme.text3)
                }
            }
        }
    }

    // MARK: What bots are saying

    /// Account chips only make sense when the window shows both accounts.
    private var visibleChips: [FeedChip] { d.filter == .all ? FeedChip.allCases : [.everything, .needsMe] }
    private var activeChip: FeedChip { visibleChips.contains(chip) ? chip : .everything }

    /// `d.activity` already has the global account filter; the chip narrows it further.
    private var shownActivity: [ActivityItem] {
        d.activity.filter { activeChip.matches($0) }.sorted { ($0.at, $0.seq) > ($1.at, $1.seq) }
    }

    private var timelineSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    SectionLabel(text: "What bots are saying")
                    chipRow
                }
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel(text: "What bots are saying")
                    chipRow
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            timeline
        }
    }

    private var chipRow: some View {
        HStack(spacing: 6) {
            ForEach(visibleChips, id: \.self) { option in
                let on = option == activeChip
                Button { chip = option } label: {
                    Text(option.label)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(on ? Theme.onInk : Theme.text2)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 4)
                        .background(Capsule().fill(on ? Theme.ink : Theme.surface))
                        .overlay(Capsule().strokeBorder(on ? Theme.ink : Theme.line))
                        .fixedSize()
                }
                .buttonStyle(PlainRowButtonStyle())
                .accessibilityAddTraits(on ? [.isSelected] : [])
            }
        }
    }

    @ViewBuilder private var timeline: some View {
        let items = shownActivity
        if items.isEmpty {
            let empty = d.activity.isEmpty ? "No updates yet. Bots push these as they work." : "No updates match this filter."
            Text(verbatim: empty)
                .font(Theme.F.body).foregroundStyle(Theme.text3)
                .padding(14).frame(maxWidth: .infinity, alignment: .leading).card()
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(FeedSection.group(items, now: d.now)) { section in
                    SectionLabel(text: section.title).padding(.leading, 54).padding(.top, 4).padding(.bottom, 8)
                    ForEach(Array(section.items.enumerated()), id: \.element.seq) { index, item in
                        FeedTimelineRow(item: item, now: d.now, connects: index < section.items.count - 1)
                    }
                }
                Text(verbatim: "Latest \(items.count) update\(items.count == 1 ? "" : "s") · bots push these")
                    .font(Theme.F.caption).foregroundStyle(Theme.text3).frame(maxWidth: .infinity).padding(.top, 6)
            }
        }
    }

    // MARK: Working now and by account

    private var workingCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "Working now · \(d.working.count)").padding(.bottom, 6)
            if d.working.isEmpty {
                Text("No bot is working right now.").font(Theme.F.small).foregroundStyle(Theme.text3).padding(.vertical, 4)
            }
            ForEach(d.working, id: \.key) { row in
                HStack(spacing: 8) {
                    FeedWorkingLabel(row: row)
                    Spacer(minLength: 8)
                    Text(row.account.label).font(Theme.F.caption).foregroundStyle(Theme.text3).fixedSize()
                }
                .padding(.vertical, 5)
                .help(row.step)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    /// Narrow windows: working bots as wrapping chips instead of the side card.
    private var workingChips: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: "Working now · \(d.working.count)")
            if d.working.isEmpty {
                Text("No bot is working right now.").font(Theme.F.small).foregroundStyle(Theme.text3)
            } else {
                FlowLayout(spacing: 6, lineSpacing: 6).callAsFunction {
                    ForEach(d.working, id: \.key) { row in
                        HStack(spacing: 6) {
                            FeedWorkingLabel(row: row)
                            Text(row.account.label).font(Theme.F.caption).foregroundStyle(Theme.text3).lineLimit(1)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Capsule().fill(Theme.surface))
                        .overlay(Capsule().strokeBorder(Theme.line))
                        .help(row.step)
                    }
                }
            }
        }
    }

    private var byAccountCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "By account")
            if d.accountsWithBots.isEmpty {
                Text("No bots in this view.").font(Theme.F.small).foregroundStyle(Theme.text3)
            }
            ForEach(d.accountsWithBots, id: \.self) { account in
                HStack(spacing: 10) {
                    AccountTag(account: account)
                    HStack(spacing: 3) {
                        ForEach(dotRows(account), id: \.key) { row in Dot(tone: row.state.tone, size: 8) }
                    }
                    Spacer(minLength: 8)
                    Text(counts(account)).font(Theme.F.caption).foregroundStyle(Theme.text2).lineLimit(1).fixedSize()
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    /// Up to 12 of an account's bots, the ones that need Avi first.
    private func dotRows(_ account: FleetAccount) -> [BotRow] {
        let mine = d.rows.filter { $0.account == account }
        let ordered = mine.filter { $0.state.needsAttention } + mine.filter { !$0.state.needsAttention }
        return Array(ordered.prefix(12))
    }

    /// "21 bots · 4 need you", "4 bots · 1 needs you".
    private func counts(_ account: FleetAccount) -> String {
        let c = d.count(account)
        let bots = c.bots == 1 ? "1 bot" : "\(c.bots) bots"
        let need = c.needYou == 1 ? "1 needs you" : "\(c.needYou) need you"
        return "\(bots) · \(need)"
    }
}

// MARK: - Helpers

/// Timeline filter chips. "Needs me" keeps the kinds that ask something of Avi.
private enum FeedChip: CaseIterable {
    case everything, needsMe, work, admin

    var label: String {
        switch self {
        case .everything: return "Everything"
        case .needsMe: return "Needs me"
        case .work: return FleetAccount.work.label
        case .admin: return FleetAccount.leaf.label
        }
    }

    func matches(_ item: ActivityItem) -> Bool {
        switch self {
        case .everything: return true
        case .needsMe: return ["waiting_user", "error", "message"].contains(item.kind)
        case .work: return item.account == .work
        case .admin: return item.account == .leaf
        }
    }
}

/// Consecutive feed items under one heading ("Now", "Earlier today", "Yesterday", …).
private struct FeedSection: Identifiable {
    let title: String
    var items: [ActivityItem]
    var id: Int { items.first?.seq ?? 0 }

    static func group(_ items: [ActivityItem], now: Double) -> [FeedSection] {
        var out: [FeedSection] = []
        for item in items {
            let title = Fmt.feedSection(item.at, now: now)
            if out.last?.title == title {
                out[out.count - 1].items.append(item)
            } else {
                out.append(FeedSection(title: title, items: [item]))
            }
        }
        return out
    }
}

/// Dot and name of a working bot: blue for Avi's Work, green for Admin.
private struct FeedWorkingLabel: View {
    let row: BotRow

    var body: some View {
        HStack(spacing: 8) {
            Dot(tone: row.account == .work ? .blue : .green)
            Text(row.bot.name).font(Theme.F.bodyBold).foregroundStyle(Theme.text).lineLimit(1)
        }
    }
}

/// One pinned Needs-my-attention card: state and age, bot, account, step, Open chat.
/// Clicking the name shows the bot in Focus.
private struct FeedAttentionCard: View {
    let row: BotRow
    let now: Double
    let onFocus: () -> Void

    var body: some View {
        let tone = row.state.tone
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(row.state.label.uppercased())
                    .font(Theme.F.label)
                    .tracking(0.4)
                    .foregroundStyle(Theme.fg(tone))
                    .lineLimit(1)
                Spacer(minLength: 6)
                if let at = Rules.lastSeenAt(row.bot) {
                    Text(Fmt.age(at, now: now)).font(Theme.F.caption).foregroundStyle(Theme.text3).help(Fmt.full(at))
                }
            }
            Button(action: onFocus) {
                Text(row.bot.name).font(Theme.F.bodyBold).foregroundStyle(Theme.text).lineLimit(1)
            }
            .buttonStyle(PlainRowButtonStyle())
            .help("Show \(row.bot.name) in Focus")
            AccountTag(account: row.account)
            Text(row.step).font(Theme.F.small).foregroundStyle(Theme.text2).lineLimit(1).help(row.step)
            OpenChatButton(bot: row.bot, compact: true).padding(.top, 2)
        }
        .padding(.leading, 15)
        .padding([.trailing, .vertical], 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .leading) { Rectangle().fill(Theme.fill(tone)).frame(width: 3) }
        .card()
    }
}

/// Dashed violet strip for a bot in Save for later. Read-only: no Move back.
private struct FeedSavedStrip: View {
    let row: BotRow
    let now: Double

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "bookmark.fill").font(.system(size: 12)).foregroundStyle(Theme.fg(.violet))
            Text("Saved:").font(Theme.F.bodyBold).foregroundStyle(Theme.text).fixedSize()
            Text(verbatim: "\(row.bot.name) · \(row.step)")
                .font(Theme.F.body).foregroundStyle(Theme.fg(.violet)).lineLimit(1).truncationMode(.tail)
            AccountTag(account: row.account)
            Spacer(minLength: 8)
            OpenChatButton(bot: row.bot, compact: true)
            if let savedAt = row.bot.savedAt {
                Text(verbatim: "since \(Fmt.clockOrDate(savedAt, now: now))")
                    .font(Theme.F.caption).foregroundStyle(Theme.text3).lineLimit(1).fixedSize()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .card(fill: Theme.tint(.violet).opacity(0.35), dashed: true)
        .help(row.step)
    }
}

/// One timeline entry: a round avatar on the connector line, then a card with the update.
private struct FeedTimelineRow: View {
    let item: ActivityItem
    let now: Double
    /// Draw the line down to the next avatar in the same section.
    let connects: Bool

    var body: some View {
        let tone = Rules.activityTone(kind: item.kind)
        HStack(alignment: .top, spacing: 14) {
            Avatar(name: item.botName, tone: tone, size: 40, circle: true)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(item.botName).font(Theme.F.bodyBold).foregroundStyle(Theme.text).lineLimit(1)
                    AccountTag(account: item.account)
                    Pill(text: Rules.activityBadge(kind: item.kind), tone: tone)
                    Spacer(minLength: 8)
                    Text(Fmt.clockOrDate(item.at, now: now))
                        .font(Theme.F.caption).foregroundStyle(Theme.text3)
                        .lineLimit(1).fixedSize().help(Fmt.full(item.at))
                }
                Text(message).font(.system(size: 14)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
        }
        .padding(.bottom, 10)
        .background(alignment: .topLeading) {
            if connects {
                Rectangle().fill(Theme.line).frame(width: 2).padding(.top, 40).padding(.leading, 19)
            }
        }
    }

    /// A message shows its first words as a quote; other kinds use the shared feed copy.
    private var message: String {
        if item.kind == "message", let detail = item.detail { return "“\(detail)”" }
        return Rules.activityText(kind: item.kind, detail: item.detail)
    }
}
