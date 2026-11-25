import AppKit
import SwiftUI

/// Entry point. `--snapshot` renders the window from a sample /api/v1/state file for CI and exits;
/// otherwise the normal SwiftUI app runs.
@main
enum BotFleetMain {
    @MainActor
    static func main() {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--snapshot"), args.count > i + 2 {
            let ok = Snapshot.run(sample: args[i + 1], out: args[i + 2], options: Array(args[(i + 3)...]))
            exit(ok ? 0 : 1)
        }
        BotFleetApp.main()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Filled in once SwiftUI has created the menu-bar label. Opens the single dashboard window.
    var showWindow: (() -> Void)?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        // The menu-bar label may not be listening yet. Try now and once more shortly after.
        present()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.present()
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        if !flag {
            present()
        } else {
            orderFront()
        }
        return true
    }

    func present() {
        NSApp.activate(ignoringOtherApps: true)
        showWindow?()
        orderFront()
    }

    private func orderFront() {
        for window in NSApp.windows where window.title == "Bot Fleet" {
            window.makeKeyAndOrderFront(nil)
        }
    }
}

struct BotFleetApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = FleetModel()

    var body: some Scene {
        MenuBarExtra {
            MenuView(model: model)
        } label: {
            MenuBarLabel(model: model)
        }
        .menuBarExtraStyle(.menu)

        Window("Bot Fleet", id: "dashboard") {
            DashboardView(model: model)
                .frame(minWidth: 560, minHeight: 480)
        }
        .defaultSize(width: 1440, height: 900)
        .commands {
            CommandMenu("Window size") {
                Button("Normal (1440×900)") { resize(NSSize(width: 1440, height: 900)) }
                Button("Wide and short (1920×700)") { resize(NSSize(width: 1920, height: 700)) }
                Button("Tall and narrow (600×1400)") { resize(NSSize(width: 600, height: 1400)) }
            }
        }
    }

    private func resize(_ size: NSSize) {
        NSApp.activate(ignoringOtherApps: true)
        guard let window = NSApp.windows.first(where: { $0.title == "Bot Fleet" }) else { return }
        window.setContentSize(size)
        window.center()
        window.makeKeyAndOrderFront(nil)
    }
}

/// Lives for the life of the process, so launch and Dock-click can open the window.
private struct MenuBarLabel: View {
    @ObservedObject var model: FleetModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text(model.badge)
            .onAppear { wire() }
            .onReceive(NotificationCenter.default.publisher(for: .botFleetShowWindow)) { _ in
                openDashboard(openWindow)
            }
    }

    private func wire() {
        let open = openWindow
        let opener: () -> Void = { openDashboard(open) }
        if let delegate = NSApp.delegate as? AppDelegate {
            delegate.showWindow = opener
        }
        opener()
    }
}

private func openDashboard(_ open: OpenWindowAction) {
    open(id: "dashboard")
    NSApp.activate(ignoringOtherApps: true)
    for window in NSApp.windows where window.title == "Bot Fleet" {
        window.makeKeyAndOrderFront(nil)
    }
}

/// The menu-bar list: what needs Avi, each with its account. Clicking one shows it in Focus.
private struct MenuView: View {
    @ObservedObject var model: FleetModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            Text(model.status)
            if model.items.isEmpty {
                Button("Open Fleet") { show() }
            } else {
                ForEach(Array(model.items.prefix(8)), id: \.key) { item in
                    Button("\(item.name) · \(DisplayState(attentionState: item.state).label) · \(item.accountLabel)") {
                        model.focus(on: item.key)
                        show()
                    }
                }
                if model.items.count > 8 {
                    Text("\(model.items.count - 8) more")
                }
            }
            Divider()
            Button("Settings…") {
                show()
                model.showSettings = true
            }
            Button("Refresh") { Task { await model.refresh() } }
            Divider()
            Button("Quit Bot Fleet") { NSApplication.shared.terminate(nil) }
        }
        .onAppear { Task { await model.refresh() } }
    }

    private func show() {
        openDashboard(openWindow)
    }
}
