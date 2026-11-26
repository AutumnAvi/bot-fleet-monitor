import SwiftUI

// The usage strip under the top bar, and the Grok per-bot breakdown popover.

// MARK: Usage strip

/// Always on top of every tab: the two Grok bars first, then Claude, Cursor, Codex and API pools in
/// one compact row that stays hidden until some of them have reported.
struct UsageStrip: View {
    let state: FleetState
    let now: Double
    @Environment(\.widthClass) private var width

    var body: some View {
        let tiles = UsageTile.all(state, now: now)
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                GrokBar(account: .work, usage: grok(.work), now: now)
                Rectangle().fill(Theme.line).frame(width: 1)
                GrokBar(account: .leaf, usage: grok(.leaf), now: now)
            }
            .fixedSize(horizontal: false, vertical: true)
            if !tiles.isEmpty {
                Rectangle().fill(Theme.line).frame(height: 1)
                grid(tiles)
            }
        }
        .frame(maxWidth: .infinity).background(Theme.surface)
    }

    private func grok(_ account: FleetAccount) -> GrokUsage? { state.grok.first { $0.account == account } }

    private func grid(_ tiles: [UsageTile]) -> some View {
        // One row of compact tiles; narrow windows wrap at three.
        let rows = Self.rows(tiles, maxColumns: width == .narrow ? 3 : 10)
        return VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                if index > 0 { Rectangle().fill(Theme.line).frame(height: 1) }
                HStack(spacing: 0) {
                    ForEach(Array(row.enumerated()), id: \.offset) { column, tile in
                        if column > 0 { Rectangle().fill(Theme.line).frame(width: 1) }
                        if let tile {
                            UsageTileView(tile: tile)
                        } else {
                            Theme.surface.frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                }
                // Every tile in a row takes the tallest tile's height, so the hairlines run full height.
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// rows = ceil(n / max), columns = ceil(n / rows). A short last row is padded with empty cells.
    private static func rows(_ tiles: [UsageTile], maxColumns: Int) -> [[UsageTile?]] {
        let n = max(tiles.count, 1)
        let rowCount = (n + maxColumns - 1) / maxColumns
        let columns = (n + rowCount - 1) / rowCount
        return stride(from: 0, to: tiles.count, by: columns).map { start -> [UsageTile?] in
            var row: [UsageTile?] = tiles[start..<min(start + columns, tiles.count)].map { $0 }
            while row.count < columns { row.append(nil) }
            return row
        }
    }
}

/// "⚡ Grok · Avi's Work  41%   as of 3:49 PM" over a bar, or one muted "no data yet" line.
/// Hovering (or clicking) opens the per-bot breakdown.
private struct GrokBar: View {
    let account: FleetAccount
    let usage: GrokUsage?
    let now: Double
    @Environment(\.widthClass) private var width
    @State private var show = false
    @State private var overBar = false
    @State private var overPopover = false

    var body: some View {
        if let usage, !usage.bots.isEmpty {
            content
                .contentShape(Rectangle())
                .onHover { inside in
                    overBar = inside
                    if inside { show = true } else { closeSoon() }
                }
                .onTapGesture { show.toggle() }
                .popover(isPresented: $show, arrowEdge: .bottom) {
                    GrokBreakdown(account: account, usage: usage, now: now)
                        .onHover { inside in
                            overPopover = inside
                            if !inside { closeSoon() }
                        }
                }
                // Escape or a focus change closes it without a hover-out.
                .onChange(of: show) { _, open in if !open { overPopover = false } }
                .accessibilityAddTraits(.isButton)
                .accessibilityHint("Shows the per-bot breakdown")
        } else {
            content
        }
    }

    /// Leaving the bar for the popover (or back) keeps it open.
    private func closeSoon() {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 300_000_000)
            if !overBar && !overPopover { show = false }
        }
    }

    /// "as of 12:29 PM": when Grok Bot's usage report was read.
    @ViewBuilder private var asOf: some View {
        if let at = usage?.readAt {
            Text("as of \(Fmt.clockOrDate(at, now: now))").font(Theme.F.caption)
                .foregroundStyle(Theme.text3).lineLimit(1).help(Fmt.full(at))
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("⚡ Grok · \(account.label)").font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.fg(.sky)).lineLimit(1).layoutPriority(1)
                if let usage {
                    Text(Fmt.percent(usage.pctUsed)).font(Theme.F.big).monospacedDigit()
                        .foregroundStyle(usage.pctUsed >= 80 ? Theme.fg(.red) : Theme.text).fixedSize()
                }
                Spacer(minLength: 6)
                if width != .narrow { asOf }
            }
            if let usage {
                Bar(fraction: usage.pctUsed / 100, tone: usage.pctUsed >= 80 ? .red : .sky, height: 5)
                if width == .narrow { asOf }
            } else {
                Text("no data yet").font(Theme.F.small).foregroundStyle(Theme.text3).lineLimit(1)
            }
        }
        .padding(.horizontal, width == .narrow ? 12 : 16)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.tint(.sky))
    }
}

/// One thin bar inside a tile (Claude 5h and week, Cursor's three meters); its text is in the tooltip.
private struct UsageMeterLine {
    let fraction: Double?
    let tone: Tone
    /// "5-hour · 62% left · resets Wed, Nov 25, 3:49 PM".
    let help: String
}

/// What one usage tile shows, computed from the data.
private struct UsageTile {
    let title: String
    var titleTone: Tone?
    var resets: [String] = []  // header reset labels, most important first; the header drops what does not fit
    var big = "–"
    var bigTone: Tone?  // set only when the number is low (amber or red)
    var caption = "no report yet"
    var compactCaption: String?  // the one-line wide tile's caption, when it differs
    var fraction: Double?  // the single bar: wide tiles, and tiles without labelled meters
    var tone: Tone = .gray
    var meters: [UsageMeterLine] = []
    var notes: [String] = []

    /// Claude, Cursor, Codex and API tiles that have a number. Empty until something reports.
    static func all(_ state: FleetState, now: Double) -> [UsageTile] {
        Usage.sorted(state.accounts).map { usageTile($0, now: now) }.filter { $0.big != "–" }
    }

    static func usageTile(_ a: UsageAccount, now: Double) -> UsageTile {
        switch a.group {
        case "claude": return claude(a, now: now)
        case "cursor": return cursor(a, now: now)
        case "api": return api(a, now: now)
        default: return percentLeft(a, meter: Usage.primary(a), now: now)
        }
    }

    /// Big 5-hour percent left, plus labelled 5h and Week bars.
    static func claude(_ a: UsageAccount, now: Double) -> UsageTile {
        let five = Usage.fiveHour(a)
        var t = percentLeft(a, meter: five ?? Usage.primary(a), now: now)
        if let five { t.meters.append(leftLine(five, group: a.group)) }
        guard let week = Usage.weekly(a) else { return t }
        t.meters.append(leftLine(week, group: a.group))
        if Usage.showWeeklyReset(week, now: now), let at = week.resetAt {
            t.resets.append("wk resets \(Fmt.reset(at, now: now))")
        }
        if let left = Usage.remaining(week) {
            t.compactCaption = [t.caption, "wk \(Fmt.percent(left))"].filter { !$0.isEmpty }.joined(separator: " · ")
        }
        return t
    }

    /// Codex and other plans: the primary meter's percent left and one bar.
    static func percentLeft(_ a: UsageAccount, meter: UsageMeter?, now: Double) -> UsageTile {
        var t = UsageTile(title: Usage.displayName(a))
        guard let meter else { return t }
        let left = Usage.remaining(meter)
        t.tone = Usage.leftTone(left, group: a.group)
        t.resets = meter.resetAt.map { [Fmt.reset($0, now: now)] } ?? []
        t.caption = ""
        if meter.noLimit {
            t.big = "No limit"
            t.fraction = 1
        } else if let left {
            t.big = Fmt.percent(left)
            t.caption = "left"
            t.fraction = left / 100
            t.bigTone = t.tone == .red || t.tone == .amber ? t.tone : nil
        }
        return t
    }

    /// Big primary percent used (plus spend), and up to three labelled meters.
    static func cursor(_ a: UsageAccount, now: Double) -> UsageTile {
        var t = UsageTile(title: Usage.displayName(a))
        let main = Usage.primary(a)
        let used: Double? = main.flatMap { $0.noLimit ? nil : $0.pctUsed }
        t.big = used.map { Fmt.percent($0) } ?? (main?.noLimit == true ? "No limit" : "–")
        t.tone = usedTone(used)
        t.bigTone = t.tone == .red ? .red : nil
        t.fraction = used.map { $0 / 100 }
        let parts: [String?] = [used == nil ? nil : "used", Usage.money(a.spend)]
        let caption = parts.compactMap { $0 }.joined(separator: " · ")
        if main != nil || !caption.isEmpty { t.caption = caption }
        t.resets = (main?.resetAt).map { [Fmt.reset($0, now: now)] } ?? []
        t.meters = a.meters.prefix(3).map { usedLine($0) }
        return t
    }

    /// API pool: dollars left of granted, expiry, and routing hints.
    static func api(_ a: UsageAccount, now: Double) -> UsageTile {
        var t = UsageTile(title: Usage.displayName(a))
        let ratio = Usage.apiRemaining(a)
        let remaining = Usage.money(a.remaining)
        let spend = Usage.money(a.spend)
        t.tone = Usage.leftTone(ratio, group: "api")
        t.fraction = ratio.map { $0 / 100 }
        t.big = remaining ?? spend ?? "–"
        t.bigTone = t.tone == .red ? .red : nil
        var caption: [String] = []
        if remaining == nil, spend != nil { caption.append("spent") }
        if let granted = Usage.money(a.granted) { caption.append("/ \(granted)") }
        if !caption.isEmpty || t.big != "–" { t.caption = caption.joined(separator: " ") }
        t.resets = a.expiresAt.map { ["exp \(Fmt.reset($0, now: now))"] } ?? []
        if a.routingVerified == false {
            t.notes.append("unverified")
            t.compactCaption = [t.caption, "unverified"].filter { !$0.isEmpty }.joined(separator: " · ")
        }
        if let note = a.note, !note.isEmpty { t.notes.append(note) }
        return t
    }

    static func leftLine(_ m: UsageMeter, group: String) -> UsageMeterLine {
        let left = Usage.remaining(m)
        let value = m.noLimit ? "No limit" : (left.map { Fmt.percent($0) } ?? "–")
        let fraction: Double? = m.noLimit ? 1 : left.map { $0 / 100 }
        return UsageMeterLine(fraction: fraction, tone: Usage.leftTone(left, group: group),
                              help: help(m, left == nil ? value : "\(value) left"))
    }

    static func usedLine(_ m: UsageMeter) -> UsageMeterLine {
        let used: Double? = m.noLimit ? nil : m.pctUsed
        let pct = used.map { Fmt.percent($0) } ?? (m.noLimit ? "No limit" : "–")
        let value = used == nil ? pct : "\(pct) used"
        return UsageMeterLine(fraction: used.map { $0 / 100 }, tone: usedTone(used), help: help(m, value))
    }

    static func usedTone(_ used: Double?) -> Tone { (used ?? 0) >= 80 ? .red : .blue }

    static func help(_ m: UsageMeter, _ value: String) -> String {
        let parts: [String?] = [m.label, value, m.resetAt.map { "resets \(Fmt.full($0))" }]
        return parts.compactMap { $0 }.joined(separator: " · ")
    }
}

private struct UsageTileView: View {
    let tile: UsageTile
    @Environment(\.widthClass) private var width

    var body: some View {
        card.help(([tile.title] + tile.resets + tile.meters.map(\.help) + tile.notes).joined(separator: "\n"))
    }

    /// One compact tile at every width: title and reset, then number, caption and bar on one line.
    /// Tiles with several meters (Claude 5h and week, Cursor's three) stack a thin bar per meter.
    private var card: some View {
        VStack(alignment: .leading, spacing: 3) {
            // The reset label shortens, then disappears, when the tile is too narrow for it.
            ViewThatFits(in: .horizontal) {
                header(tile.resets.joined(separator: " · "))
                header(tile.resets.first)
                header(nil)
            }
            HStack(spacing: 8) {
                value(tile.compactCaption ?? tile.caption).layoutPriority(1)
                bars.frame(minWidth: 24)
            }
        }
        .padding(.horizontal, width == .narrow ? 10 : 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.surface)
    }

    @ViewBuilder private var bars: some View {
        if tile.meters.count > 1 {
            VStack(spacing: 2) {
                ForEach(Array(tile.meters.enumerated()), id: \.offset) { _, line in
                    Bar(fraction: line.fraction, tone: line.tone, height: 3)
                }
            }
        } else {
            Bar(fraction: tile.fraction, tone: tile.tone, height: 4)
        }
    }

    private func header(_ reset: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(tile.title.uppercased()).font(Theme.F.label).tracking(0.4)
                .foregroundStyle(tile.titleTone.map { Theme.fg($0) } ?? Theme.text2).lineLimit(1)
            Spacer(minLength: 6)
            if let reset, !reset.isEmpty {
                Text(reset).font(Theme.F.caption).foregroundStyle(Theme.text3).lineLimit(1)
            }
        }
    }

    /// Big number plus its caption: "62% left · wk 71%", "45% used · $142", "$318 / $500".
    private func value(_ caption: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(tile.big).font(Theme.F.big).monospacedDigit()
                .foregroundStyle(tile.bigTone.map { Theme.fg($0) } ?? Theme.text)
                .lineLimit(1).minimumScaleFactor(0.7).layoutPriority(1)
            Text(caption).font(Theme.F.small).foregroundStyle(Theme.text2).lineLimit(1)
        }
    }
}

// MARK: Grok breakdown

/// Per-bot share of one account's Grok usage this week. Popover content on a Grok tile.
struct GrokBreakdown: View {
    let account: FleetAccount
    let usage: GrokUsage?
    let now: Double

    private static let routinesColor = Color(hex: 0xA5B4FC)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) { heading; Spacer(minLength: 8); status }
                    VStack(alignment: .leading, spacing: 2) { heading; status }
                }
                Text("Share of this account's usage this week, by bot")
                    .font(Theme.F.small).foregroundStyle(Theme.text2)
            }
            rows
            Rectangle().fill(Theme.line).frame(height: 1)
            HStack(spacing: 14) {
                legendItem(Theme.fill(.sky), "chats & tasks")
                legendItem(Self.routinesColor, "mostly routines")
                Spacer(minLength: 8)
                if let at = usage?.readAt {
                    Text("as of \(Fmt.clockOrDate(at, now: now))")
                        .font(Theme.F.caption).foregroundStyle(Theme.text3)
                }
            }
        }
        .padding(14)
        .frame(width: 440, alignment: .leading).background(Theme.surface)
    }

    private var heading: some View {
        Text("⚡ Grok Bot · \(account.label)").font(.system(size: 14, weight: .bold)).foregroundStyle(Theme.text)
    }

    private var status: some View {
        Text(statusText).font(Theme.F.small).foregroundStyle(Theme.text2).lineLimit(1)
    }

    private var statusText: String {
        guard let usage else { return "No report yet" }
        let used = "\(Fmt.percent(usage.pctUsed)) used"
        return usage.resetAt.map { "\(used) · resets \(Fmt.full($0))" } ?? used
    }

    @ViewBuilder private var rows: some View {
        if let usage, !usage.bots.isEmpty {
            let split = Usage.grokTop(usage)
            let largest = max(split.top.first?.share ?? 0, split.othersShare, 0.0001)
            VStack(spacing: 7) {
                ForEach(Array(split.top.enumerated()), id: \.offset) { index, bot in
                    shareRow(rank: "\(index + 1)", name: bot.name, share: bot.share, largest: largest,
                             color: Usage.mostlyRoutines(bot) ? Self.routinesColor : Theme.fill(.sky))
                }
                if split.others > 0 {
                    shareRow(rank: "", name: "\(split.others) others", share: split.othersShare, largest: largest,
                             color: Theme.fill(.gray), muted: true)
                }
            }
        } else {
            Text("No per-bot breakdown was pushed.").font(Theme.F.small).foregroundStyle(Theme.text3)
        }
    }

    /// Rank, bot name, a bar sized against the largest share, and the share.
    private func shareRow(rank: String, name: String, share: Double, largest: Double, color: Color,
                          muted: Bool = false) -> some View {
        HStack(spacing: 10) {
            Text(rank).font(Theme.F.caption).monospacedDigit().foregroundStyle(Theme.text3)
                .frame(width: 14, alignment: .leading)
            Text(name).font(Theme.F.body).foregroundStyle(muted ? Theme.text2 : Theme.text).lineLimit(1)
                .frame(width: 170, alignment: .leading)
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.line)
                    Capsule().fill(color).frame(width: g.size.width * CGFloat(min(max(share / largest, 0), 1)))
                }
            }
            .frame(height: 6)
            Text(Fmt.percent(share)).font(Theme.F.bodyBold).monospacedDigit()
                .foregroundStyle(muted ? Theme.text2 : Theme.text).frame(width: 40, alignment: .trailing)
        }
    }

    private func legendItem(_ color: Color, _ label: String) -> some View {
        HStack(spacing: 5) {
            RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 8, height: 8)
            Text(label).font(Theme.F.caption).foregroundStyle(Theme.text2)
        }
    }
}
