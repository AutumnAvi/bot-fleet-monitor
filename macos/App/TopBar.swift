import SwiftUI

// The dark top bar. Read-only: its actions switch tab or filter, refresh, and open Settings.

/// "Fleet · Monitor", tabs, account filter, Hebron clock, Live/Offline, Refresh and Settings.
struct TopBar: View {
    @ObservedObject var model: FleetModel
    let d: FleetDerived
    @Environment(\.widthClass) private var width

    private var narrow: Bool { width == .narrow }

    var body: some View {
        HStack(spacing: narrow ? 10 : 14) {
            HStack(spacing: 0) {
                Text("Fleet").font(.system(size: 17, weight: .bold)).foregroundStyle(Theme.barText)
                if !narrow { Text(" · \(model.tab.title)").font(.system(size: 17)).foregroundStyle(Theme.barText2) }
            }
            .lineLimit(1).fixedSize()
            tabs
            Spacer(minLength: 8)
            if narrow { filterMenu } else { filterPills }
            if !narrow {
                Text(Fmt.headerClock(model.now)).font(.system(size: 13)).monospacedDigit()
                    .foregroundStyle(Theme.barText2).lineLimit(1).fixedSize()
            }
            connection
            iconButton("arrow.clockwise", help: "Refresh now (⌘R)") { Task { await model.refresh() } }
                .keyboardShortcut("r", modifiers: .command)
            iconButton("gearshape", help: "Settings") { model.showSettings = true }
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity).frame(height: narrow ? 48 : 52)
        .background(Theme.bar)
        // Dark in both appearances, so AppKit-drawn parts (the narrow filter menu) use light text.
        .environment(\.colorScheme, .dark)
    }

    /// Monitor as the one primary pill (⌘1), then Board, Feed and Later as quieter text (⌘2–⌘4).
    /// Focus appears here only while it is open.
    private var tabs: some View {
        HStack(spacing: narrow ? 0 : 2) {
            tabButton(.monitor, primary: true, shortcut: "1")
            ForEach(secondary, id: \.self) { tab in
                tabButton(tab, primary: false, shortcut: DashboardTab.secondary.firstIndex(of: tab).map { "\($0 + 2)" })
            }
        }
        .fixedSize()
    }

    private var secondary: [DashboardTab] {
        model.tab == .focus ? [.focus] + DashboardTab.secondary : DashboardTab.secondary
    }

    private func tabButton(_ tab: DashboardTab, primary: Bool, shortcut: String?) -> some View {
        let selected = model.tab == tab
        let button = Button { model.tab = tab } label: {
            Text(tab.title).font(.system(size: primary ? 13 : 12.5, weight: selected ? .semibold : (primary ? .medium : .regular)))
                .foregroundStyle(selected ? Theme.bar : Theme.barText2.opacity(primary ? 1 : 0.85))
                .padding(.horizontal, primary ? (narrow ? 10 : 14) : (narrow ? 6 : 9)).padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 8).fill(selected ? Color.white : (primary ? Theme.barRaised : Color.clear)))
        }
        .buttonStyle(PlainRowButtonStyle())
        .help(tabHelp(tab, shortcut: shortcut))
        .padding(.trailing, primary ? (narrow ? 4 : 8) : 0)
        return Group {
            if let shortcut, let key = shortcut.first {
                button.keyboardShortcut(KeyEquivalent(key), modifiers: .command)
            } else {
                button
            }
        }
    }

    private func tabHelp(_ tab: DashboardTab, shortcut: String?) -> String {
        let key = shortcut.map { " (⌘\($0))" } ?? ""
        switch tab {
        case .monitor: return "Monitor · accounts, coding sessions, recently used\(key)"
        case .focus: return "Focus · \(d.attention.count) need you"
        case .later: return "Saved for later · \(d.saved.count)\(key)"
        default: return "\(tab.title)\(key)"
        }
    }

    /// Regular and wide: three outlined pills.
    private var filterPills: some View {
        HStack(spacing: 6) {
            ForEach(AccountFilter.allCases, id: \.self) { filter in
                let selected = model.filter == filter
                Button { model.filter = filter } label: {
                    Text(filter.label).font(.system(size: 13, weight: .medium)).lineLimit(1)
                        .foregroundStyle(selected ? Theme.barText : Theme.barText2)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(selected ? Color.white : Theme.barLine))
                }
                .buttonStyle(PlainRowButtonStyle())
            }
        }
        .fixedSize()
    }

    /// Narrow: one "All ▾" menu.
    private var filterMenu: some View {
        Menu {
            ForEach(AccountFilter.allCases, id: \.self) { filter in
                Button(filter == model.filter ? "✓ \(filter.label)" : filter.label) { model.filter = filter }
            }
        } label: {
            Text("\(model.filter.label) ▾").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.barText)
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .padding(.horizontal, 10).padding(.vertical, 5)
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.barLine))
        .help("Show both accounts or one")
    }

    private var connection: some View {
        var label = "Live"
        var tone = Tone.green
        if case .some(.offline) = model.problem {
            label = "Offline"
            tone = .amber
        } else if let other = model.problem {
            label = other.title
            tone = .red
        }
        return HStack(spacing: 5) {
            Dot(tone: tone, size: 7)
            Text(label).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.barText2)
        }
        .fixedSize().help(updatedHelp)
    }

    private var updatedHelp: String {
        guard let last = model.lastSuccess else { return model.problem?.title ?? "Waiting for the first read" }
        return "Updated \(Fmt.clock(last.timeIntervalSince1970 * 1000))"
    }

    private func iconButton(_ symbol: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.barText2).frame(width: 26, height: 26)
        }
        .buttonStyle(PlainRowButtonStyle()).help(help).accessibilityLabel(help)
    }
}
