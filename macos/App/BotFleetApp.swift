import AppKit
import SwiftUI

@main
struct BotFleetApp: App {
    @StateObject private var model = FleetModel()

    var body: some Scene {
        MenuBarExtra {
            MenuView(model: model)
        } label: {
            Text(model.badge)
        }
        .menuBarExtraStyle(.menu)

        Window("Bot Fleet", id: "dashboard") {
            DashboardView(model: model)
                .frame(minWidth: 480, minHeight: 500)
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

private struct MenuView: View {
    @ObservedObject var model: FleetModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            Text(model.status)
            if model.items.isEmpty {
                Button("Open Fleet") { show() }
            } else {
                ForEach(Array(model.items.prefix(8)), id: \.menuID) { item in
                    Button("\(item.name) · \(item.label)") { show() }
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
        openWindow(id: "dashboard")
        NSApp.activate(ignoringOtherApps: true)
    }
}
