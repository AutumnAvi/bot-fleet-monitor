import AppKit
import SwiftUI
import UserNotifications
import WebKit

struct DashboardView: View {
    @ObservedObject var model: FleetModel

    var body: some View {
        Group {
            if let url = BaseURL.saved {
                FleetWebView(url: url)
            } else {
                VStack(spacing: 12) {
                    Text("Set the dashboard URL")
                        .font(.title2)
                    Text("The window loads Bot Fleet from that URL. The menu bar uses the read key and never messages a bot.")
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 360)
                    Button("Settings") { model.showSettings = true }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .sheet(isPresented: $model.showSettings) {
            SettingsView(model: model)
        }
    }
}

struct FleetWebView: NSViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(allowed: url) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        context.coordinator.last = url
        web.load(URLRequest(url: url))
        return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        guard context.coordinator.last != url else { return }
        context.coordinator.allowed = url
        context.coordinator.last = url
        web.load(URLRequest(url: url))
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var allowed: URL
        var last: URL?
        init(allowed: URL) { self.allowed = allowed }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let target = action.request.url else {
                decisionHandler(.cancel)
                return
            }
            if target.scheme == "grokbot" {
                NSWorkspace.shared.open(target)
                decisionHandler(.cancel)
                return
            }
            if target.scheme == "about" {
                decisionHandler(.allow)
                return
            }
            if target.host?.lowercased() == allowed.host?.lowercased(), target.scheme == allowed.scheme {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
        }
    }
}

struct SettingsView: View {
    @ObservedObject var model: FleetModel
    @Environment(\.dismiss) private var dismiss
    @State private var urlText = BaseURL.saved?.absoluteString ?? "https://bot-fleet-monitor.autumnlakemarketing.workers.dev"
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
        result = await model.test(url: urlText, key: keyText.isEmpty ? (KeychainStore.load() ?? "") : keyText)
        busy = false
    }

    private func save() async {
        guard BaseURL.save(urlText) != nil else {
            result = "Use an https URL, or http://127.0.0.1."
            return
        }
        if !keyText.isEmpty {
            guard keyText.count >= 32, KeychainStore.save(keyText) else {
                result = "Couldn't store that read key."
                return
            }
            keyText = ""
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
        result = "Saved."
        await model.refresh()
    }
}
