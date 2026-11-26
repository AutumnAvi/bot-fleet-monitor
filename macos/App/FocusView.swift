import SwiftUI

/// Focus tab (option 8): one bot that needs Avi at a time, the rest of the queue, Save for later,
/// and everything else by account. Coding sessions live in the strip under the usage bars.
struct FocusView: View {
    @ObservedObject var model: FleetModel
    let d: FleetDerived

    @Environment(\.widthClass) private var widthClass
    /// Group cards opened in the narrow layout (`GroupSummary.key`).
    @State private var expandedGroups: Set<String> = []

    private var gap: CGFloat { 18 }
    private var narrow: Bool { widthClass == .narrow }
    private var pad: CGFloat { narrow ? 14 : 20 }

    /// Position in `d.attention` of the bot on the card.
    private var currentIndex: Int {
        guard let key = model.focusKey, let index = d.attention.firstIndex(where: { $0.key == key }) else { return 0 }
        return index
    }

    private var current: BotRow? { d.attention.isEmpty ? nil : d.attention[currentIndex] }

    /// The bot "Next" shows, wrapping around. Nil when only one bot needs Avi.
    private var nextRow: BotRow? {
        d.attention.count > 1 ? d.attention[(currentIndex + 1) % d.attention.count] : nil
    }

    /// Counted like the sessions strip, so the two numbers agree.
    private var liveSessions: Int { (d.sessions + d.orphans).filter(Sessions.isLive).count }

    var body: some View {
        if narrow {
            column {
                header
                focusArea
                upNext
                savedSection
                byAccount
            }
            .padding(.horizontal, pad)
        } else {
            // wide: focus 40% | up next, saved 28% | by account 32%.
            // regular: focus, up next, saved 60% | by account 40%.
            GeometryReader { geo in
                let wide = widthClass == .wide
                let w = max(0, geo.size.width - pad * 2 - gap * (wide ? 2 : 1))
                HStack(alignment: .top, spacing: gap) {
                    column {
                        header
                        focusArea
                        if !wide {
                            upNext
                            savedSection
                        }
                    }
                    .frame(width: w * (wide ? 0.40 : 0.60))
                    if wide {
                        column {
                            upNext
                            savedSection
                        }
                        .frame(width: w * 0.28)
                    }
                    column {
                        byAccount
                    }
                    .frame(width: w * (wide ? 0.32 : 0.40))
                }
                .padding(.horizontal, pad)
            }
        }
    }

    /// One independently scrolling column (the whole page in narrow windows).
    private func column<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: gap) { content() }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, pad)
        }
    }

    // MARK: Needs my attention

    private var header: some View {
        HStack(spacing: 12) {
            Text("Needs my attention").font(Theme.F.display).foregroundStyle(Theme.text).lineLimit(1).fixedSize()
            if !d.attention.isEmpty {
                HStack(spacing: 5) {
                    ForEach(Array(d.attention.enumerated()), id: \.element.key) { index, row in
                        Capsule().fill(Theme.fill(row.state.tone)).opacity(index == currentIndex ? 1 : 0.45)
                            .frame(minWidth: 6, maxWidth: 26).frame(height: 5)
                            .help(row.bot.name)
                    }
                }
                Spacer(minLength: 8)
                Text(countText).font(Theme.F.small).foregroundStyle(Theme.text2).lineLimit(1)
            } else {
                Spacer(minLength: 0)
            }
        }
    }

    /// "1 of 5 need you · press N for next".
    private var countText: String {
        let n = d.attention.count
        if n == 1 { return "1 needs you" }
        let base = "\(currentIndex + 1) of \(n) need you"
        return narrow ? base : base + " · press N for next"
    }

    @ViewBuilder private var focusArea: some View {
        if let row = current {
            FocusCard(model: model, row: row, d: d, next: nextRow, onFocus: { model.focusKey = $0 })
        } else {
            VStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 34)).foregroundStyle(Theme.fill(.green))
                Text("Nothing needs you right now.").font(Theme.F.title).foregroundStyle(Theme.text)
                Text("\(d.working.count) working · \(FocusText.plural(liveSessions, "coding session")) live")
                    .font(Theme.F.caption).foregroundStyle(Theme.text3)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 36)
            .card()
        }
    }

    // MARK: Up next and Saved for later

    @ViewBuilder private var upNext: some View {
        let others = Array(d.attention.enumerated()).filter { $0.offset != currentIndex }
        if !others.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Up next")
                ForEach(others, id: \.element.key) { item in
                    upNextRow(item.element, number: item.offset + 1)
                }
            }
        }
    }

    /// One queued bot: one line when it fits, else two (always two in narrow windows).
    /// Tapping the row outside the button puts that bot on the card.
    private func upNextRow(_ row: BotRow, number: Int) -> some View {
        let name = HStack(spacing: 7) {
            BotSymbol(bot: row.bot)
            Text(row.bot.name).font(Theme.F.bodyBold).foregroundStyle(Theme.text).lineLimit(1)
        }
        let step = Text(row.step).font(Theme.F.body).foregroundStyle(Theme.text2).lineLimit(1)
        let numberLabel = Text("\(number)").font(Theme.F.small).foregroundStyle(Theme.text3).monospacedDigit()
            .frame(minWidth: 16, alignment: .leading)
        let oneLine = HStack(spacing: 10) {
            numberLabel
            name.frame(width: 170, alignment: .leading)
            step.frame(minWidth: 0, idealWidth: 60, maxWidth: .infinity, alignment: .leading)
            AccountTag(account: row.account)
            StateBadge(row: row, now: d.now, uppercase: false)
            ageLabel(row)
            SaveForLaterButton(model: model, bot: row.bot)
            OpenChatButton(bot: row.bot, compact: true)
        }
        let twoLines = VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                numberLabel
                name.layoutPriority(1)
                if !narrow { step }
                Spacer(minLength: 6)
                ageLabel(row)
            }
            HStack(spacing: 8) {
                AccountTag(account: row.account)
                StateBadge(row: row, now: d.now, uppercase: false)
                Spacer(minLength: 6)
                SaveForLaterButton(model: model, bot: row.bot)
                OpenChatButton(bot: row.bot, compact: true)
            }
        }
        return Group {
            if narrow {
                twoLines
            } else {
                ViewThatFits(in: .horizontal) {
                    oneLine
                    twoLines
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .card()
        .contentShape(RoundedRectangle(cornerRadius: Theme.radius))
        .onTapGesture { model.focusKey = row.key }
    }

    @ViewBuilder private func ageLabel(_ row: BotRow) -> some View {
        if let at = Rules.lastSeenAt(row.bot) {
            Text(Fmt.age(at, now: d.now)).font(Theme.F.caption).foregroundStyle(Theme.text3).monospacedDigit()
        }
    }

    @ViewBuilder private var savedSection: some View {
        if !d.saved.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Saved for later · \(d.saved.count)")
                ForEach(d.saved, id: \.key) { row in
                    SavedRow(model: model, row: row, now: d.now, narrow: narrow)
                }
            }
        }
    }

    // MARK: Everything else, by account

    private var byAccount: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Everything else, by account").font(Theme.F.title).foregroundStyle(Theme.text)
                    .lineLimit(1).layoutPriority(1)
                Spacer(minLength: 8)
                Text(liveSessions == 0 ? FocusText.plural(d.rows.count, "bot")
                     : "\(FocusText.plural(d.rows.count, "bot")) · \(FocusText.plural(liveSessions, "live coding session"))")
                    .font(Theme.F.small).foregroundStyle(Theme.text2).lineLimit(1)
            }
            ForEach(d.accountsWithBots, id: \.self) { account in
                let count = d.count(account)
                HStack(spacing: 8) {
                    Pill(text: account.label.uppercased(), tone: Theme.accountTone(account), bold: true)
                    Text(FocusText.plural(count.bots, "bot").uppercased()).font(Theme.F.label).foregroundStyle(Theme.text2)
                    Spacer(minLength: 8)
                    Text(count.needYou == 1 ? "1 needs you" : "\(count.needYou) need you")
                        .font(Theme.F.caption).foregroundStyle(Theme.text3)
                }
                .padding(.top, 4)
                ForEach(d.groups(for: account), id: \.key) { group in
                    groupCard(group)
                }
            }
        }
    }

    /// Working bots as lines, the rest as grey chips. Narrow windows fold each card to its header.
    private func groupCard(_ group: GroupSummary) -> some View {
        let parts = FocusGroupParts(group)
        let open = !narrow || expandedGroups.contains(group.key)
        let headerLine = HStack(spacing: 6) {
            Text(Rules.groupName(group.name)).font(Theme.F.bodyBold).foregroundStyle(Theme.text).lineLimit(1)
            Text("\(group.rows.count)").font(Theme.F.small).foregroundStyle(Theme.text3)
            if !open && !parts.working.isEmpty {
                Text("· \(parts.working.count) working").font(Theme.F.small).foregroundStyle(Theme.text2).lineLimit(1)
            }
            Spacer(minLength: 8)
            HStack(spacing: 4) {
                ForEach(Array(group.rows.prefix(8)), id: \.key) { row in
                    Dot(tone: row.bot.savedAt != nil ? .violet : row.state.tone, size: 7)
                }
            }
            if narrow {
                Image(systemName: open ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.text3)
            }
        }
        return VStack(alignment: .leading, spacing: 8) {
            if narrow {
                Button { toggle(group.key) } label: { headerLine }
                    .buttonStyle(PlainRowButtonStyle())
            } else {
                headerLine
            }
            if open {
                ForEach(Array(parts.working.enumerated()), id: \.element.key) { index, row in
                    if index > 0 { Divider().overlay(Theme.line) }
                    workingLine(row)
                }
                if !parts.chips.isEmpty {
                    FlowLayout(spacing: 6, lineSpacing: 6).callAsFunction {
                        ForEach(Array(parts.chips.enumerated()), id: \.offset) { _, text in
                            Text(text).font(Theme.F.caption).foregroundStyle(Theme.text2).lineLimit(1)
                                .padding(.horizontal, 7).padding(.vertical, 3)
                                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.surface2))
                                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.line))
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private func toggle(_ key: String) {
        if expandedGroups.contains(key) { expandedGroups.remove(key) } else { expandedGroups.insert(key) }
    }

    private func workingLine(_ row: BotRow) -> some View {
        HStack(spacing: 8) {
            BotSymbol(bot: row.bot, size: 14)
            Text(row.bot.name).font(Theme.F.bodyBold).foregroundStyle(Theme.text).lineLimit(1).layoutPriority(1)
            Text(row.step).font(Theme.F.body).foregroundStyle(Theme.text2).lineLimit(1)
            Spacer(minLength: 6)
            if let seen = Rules.lastSeenAt(row.bot) {
                Text(Fmt.age(seen, now: d.now)).font(Theme.F.small).foregroundStyle(Theme.text2).monospacedDigit()
                    .padding(.horizontal, 7).padding(.vertical, 1)
                    .overlay(Capsule().strokeBorder(Theme.line))
            }
        }
    }
}

// MARK: Helpers

/// A group card split the way Focus draws it: working bots as lines; the rest as chip labels
/// (needs you "↑", then saved, then idle folded into "+N idle" unless there are only one or two).
private struct FocusGroupParts {
    var working: [BotRow] = []
    var chips: [String] = []

    init(_ group: GroupSummary) {
        var attention: [String] = [], saved: [String] = [], idle: [String] = []
        for row in group.rows {
            if row.bot.savedAt != nil {
                saved.append("\(row.bot.name) · saved")
            } else if row.state.needsAttention {
                attention.append("\(row.bot.name) ↑")
            } else if row.state == .working {
                working.append(row)
            } else {
                idle.append(row.bot.name)
            }
        }
        chips = attention + saved + (idle.count <= 2 ? idle : ["+\(idle.count) idle"])
    }
}

enum FocusText {
    /// "1 bot", "25 bots".
    static func plural(_ n: Int, _ word: String) -> String { n == 1 ? "1 \(word)" : "\(n) \(word)s" }
}
