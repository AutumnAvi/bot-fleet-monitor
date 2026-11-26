import Foundation
import Security

// Where the app reads from. The read key lives in the login Keychain; the URL is not a secret.

enum KeychainStore {
    static let service = "com.autumnavi.BotFleet"
    static let account = "read-key"

    static func save(_ secret: String) -> Bool {
        let data = Data(secret.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func load() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let text = String(data: data, encoding: .utf8),
              !text.isEmpty
        else { return nil }
        return text
    }

    static func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

extension Notification.Name {
    static let botFleetShowWindow = Notification.Name("botFleetShowWindow")
}

enum BaseURL {
    static let suggested = "https://bot-fleet-monitor.autumnlakemarketing.workers.dev"
    private static let key = "botfleet.baseURL"

    static var saved: URL? {
        guard let raw = UserDefaults.standard.string(forKey: key) else { return nil }
        return normalize(raw)
    }

    static func save(_ raw: String) -> URL? {
        guard let url = normalize(raw) else { return nil }
        UserDefaults.standard.set(url.absoluteString, forKey: key)
        return url
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }

    /// Origin only. http is limited to localhost so a read key cannot be sent to some other site.
    static func normalize(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased(),
              !host.isEmpty
        else { return nil }
        let port = url.port.map { ":\($0)" } ?? ""
        if scheme == "https" {
            return URL(string: "https://\(host)\(port)")
        }
        if scheme == "http", host == "localhost" || host == "127.0.0.1" {
            return URL(string: "http://\(host)\(port)")
        }
        return nil
    }

    /// `?account=` narrows only the activity page (the newest 40 events) to one account, as the web
    /// does; bots, sessions, usage and attention are always both accounts. The server has no "all".
    static func stateURL(_ base: URL, account: AccountFilter = .all) -> URL? {
        var root = base.absoluteString
        if root.hasSuffix("/") { root.removeLast() }
        let query = account == .all ? "" : "?account=\(account.rawValue)"
        return URL(string: root + "/api/v1/state" + query)
    }
}
