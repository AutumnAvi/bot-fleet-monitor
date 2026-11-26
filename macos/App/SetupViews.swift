import AppKit
import SwiftUI
import UserNotifications

// First-run setup, Settings, and the "not v2 yet" screen. The app needs only the dashboard URL
// and the read key; there is no dashboard password and no web view.

struct SetupView: View {
    @ObservedObject var model: FleetModel
    @State private var urlText = BaseURL.saved?.absoluteString ?? BaseURL.suggested
    @State private var keyText = ""
    @State private var result = ""
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Bot Fleet")
                .font(.largeTitle)
            Text("This window is the dashboard. The menu bar keeps a count of what needs you. The app never messages a bot.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("Dashboard URL")
                .font(.headline)
            TextField("https://…", text: $urlText)
                .textFieldStyle(.roundedBorder)
            Text("Read key")
                .font(.headline)
            SecureField("Paste the read key", text: $keyText)
                .textFieldStyle(.roundedBorder)
            Text("The key stays in the Keychain. It can only read the dashboard.")
                .font(.callout)
                .foregroundStyle(.secondary)
            if !result.isEmpty {
                Text(result)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button("Test connection") { Task { await test() } }
                    .disabled(busy)
                Button("Save and open") { Task { await save() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy)
            }
        }
        .padding(36)
        .frame(maxWidth: 520, alignment: .leading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }

    private func test() async {
        busy = true
        let typed = cleanKey(keyText)
        result = await model.test(url: urlText, key: typed.isEmpty ? (KeychainStore.load() ?? "") : typed)
        busy = false
    }

    /// Checks the URL and the key before storing either, so a bad key never leaves a new URL saved.
    private func save() async {
        guard BaseURL.normalize(urlText) != nil else {
            result = "Use an https URL, or http://127.0.0.1."
            return
        }
        let typed = cleanKey(keyText)
        if !typed.isEmpty {
            guard typed.count >= 32, KeychainStore.save(typed) else {
                result = "Couldn't store that read key."
                return
            }
            keyText = ""
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        } else if KeychainStore.load() == nil {
            result = "Paste the read key, then save."
            return
        }
        _ = model.saveServer(urlText)
        result = "Saved. Checking the server…"
        await model.refresh()
        if model.httpStatus == 200 {
            result = ""
        } else if model.httpStatus == 404 {
            result = "Saved. This server doesn't have Bot Fleet v2 yet."
        }
    }
}

struct MissingV2View: View {
    @ObservedObject var model: FleetModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("This server doesn't have Bot Fleet v2 yet")
                .font(.title)
                .fixedSize(horizontal: false, vertical: true)
            Text("GET /api/v1/state returned 404. The address is still the older dashboard, so this window has nothing to show. Avi deploys v2 from his usual place. The menu bar starts counting once that endpoint exists.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Check again") { Task { await model.refresh() } }
                Button("Change server") {
                    BaseURL.clear()
                    model.forgetServerData()
                    Task { await model.refresh() }
                }
            }
        }
        .padding(36)
        .frame(maxWidth: 560, alignment: .leading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }
}

struct SettingsView: View {
    @ObservedObject var model: FleetModel
    @Environment(\.dismiss) private var dismiss
    @State private var urlText = BaseURL.saved?.absoluteString ?? BaseURL.suggested
    @State private var keyText = ""
    @State private var result = ""
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Bot Fleet").font(.title2)
            Text("The read key is stored in the Keychain. The menu bar reads /api/v1/state and does not message bots.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Text("Dashboard URL")
            TextField("https://…", text: $urlText)
                .textFieldStyle(.roundedBorder)
            Text("Read key")
            SecureField("Paste the read key", text: $keyText)
                .textFieldStyle(.roundedBorder)
            if !result.isEmpty {
                Text(result).font(.callout)
            }
            HStack {
                Button("Test") { Task { await test() } }
                    .disabled(busy)
                Button("Save") { Task { await save() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy)
                Spacer()
                Button("Forget key") {
                    KeychainStore.delete()
                    model.forgetServerData()
                    keyText = ""
                    result = "Read key removed from the Keychain."
                    Task { await model.refresh() }
                }
                Button("Close") { dismiss() }
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    private func test() async {
        busy = true
        let typed = cleanKey(keyText)
        result = await model.test(url: urlText, key: typed.isEmpty ? (KeychainStore.load() ?? "") : typed)
        busy = false
    }

    /// Checks the URL and the key before storing either, so a bad key never leaves a new URL saved.
    private func save() async {
        guard BaseURL.normalize(urlText) != nil else {
            result = "Use an https URL, or http://127.0.0.1."
            return
        }
        let typed = cleanKey(keyText)
        if !typed.isEmpty {
            guard typed.count >= 32, KeychainStore.save(typed) else {
                result = "Couldn't store that read key."
                return
            }
            keyText = ""
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
        _ = model.saveServer(urlText)
        result = "Saved."
        await model.refresh()
    }
}

/// A pasted key without the newline or spaces that come along when it is copied from a file.
private func cleanKey(_ raw: String) -> String {
    raw.trimmingCharacters(in: .whitespacesAndNewlines)
}
