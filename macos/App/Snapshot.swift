import AppKit
import SwiftUI

/// CI preview, same idea as Session Monitor's:
/// `<app> --snapshot state.json out.png [tab=focus|board|feed] [width=1440] [height=900] [dark]
///  [state=offline] [filter=all|work|leaf] [part=grok] [nodata]`
/// renders the real window from a saved GET /api/v1/state reply, prints what it decoded, and exits.
/// The clock is frozen at the sample's `now`, so ages are the same on every run. No network.
@MainActor
enum Snapshot {
    static func run(sample: String, out: String, options: [String]) -> Bool {
        func option(_ name: String) -> String? {
            options.first { $0.hasPrefix(name + "=") }.map { String($0.dropFirst(name.count + 1)) }
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        guard let data = FileManager.default.contents(atPath: sample) else {
            print("no sample at \(sample)")
            return false
        }
        var state: FleetState
        do {
            state = try JSONDecoder().decode(FleetState.self, from: data)
        } catch {
            print("decode failed: \(error)")
            return false
        }
        // `nodata`: nothing pushed yet for usage or coding sessions, as on a fresh deploy.
        if options.contains("nodata") {
            state.grok = []
            state.accounts = []
            state.sessions = []
        }
        let tab = DashboardTab(rawValue: option("tab") ?? "") ?? .focus
        let filter = AccountFilter(rawValue: option("filter") ?? "") ?? .all
        let problem: FetchProblem? = option("state") == "offline" ? .offline("Can't reach the dashboard URL.") : nil
        let model = FleetModel(preview: state, tab: tab, filter: filter, problem: problem)
        report(state, model: model)

        let width = CGFloat(Double(option("width") ?? "") ?? 1440)
        let height = CGFloat(Double(option("height") ?? "") ?? 900)
        let host: NSView
        var size = NSSize(width: width, height: height)
        if option("part") == "grok" {
            let usage = state.grok.first { $0.account == .work }
            let view = GrokBreakdown(account: .work, usage: usage, now: state.now)
                .background(Theme.surface)
            let hosting = NSHostingView(rootView: view)
            size = hosting.fittingSize
            host = hosting
        } else {
            host = NSHostingView(rootView: DashboardView(model: model))
        }
        host.appearance = NSAppearance(named: options.contains("dark") ? .darkAqua : .aqua)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.contentView = host
        window.orderFront(nil)
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            print("no bitmap")
            return false
        }
        host.cacheDisplay(in: host.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else {
            print("no png")
            return false
        }
        do {
            try png.write(to: URL(fileURLWithPath: out))
        } catch {
            print("write failed: \(error)")
            return false
        }
        print("WROTE \(out) \(Int(host.bounds.width))x\(Int(host.bounds.height)) tab=\(tab.rawValue) filter=\(filter.rawValue)")
        return true
    }

    /// Text CI can assert on: what was decoded and how the window splits it.
    private static func report(_ state: FleetState, model: FleetModel) {
        let d = FleetDerived(state: state, filter: model.filter, now: model.now)
        print("STATE version=\(state.version) bots=\(state.bots.count) attention=\(state.attention.count) sessions=\(state.sessions.count) accounts=\(state.accounts.count) grok=\(state.grok.count) activity=\(state.activity.count)")
        print("PARTITION attention=\(d.attention.count) saved=\(d.saved.count) working=\(d.working.count) idle=\(d.idle.count) rows=\(d.rows.count)")
        let strip = SessionsStrip.recent(d)
        print("STRIP sessions=\(strip.count) running=\(strip.filter(Sessions.isLive).count)")
        print("ACTIVITY raw=\(state.activity.count) visible=\(d.activity.count)")
        let shaped = d.rows.filter { BotLook.shape($0.bot.avatar?.shape) != nil }.count
        print("SYMBOLS shapes=\(shaped) initials=\(d.rows.count - shaped)")
        for row in d.rows.prefix(3) {
            print("SYMBOL \(row.bot.name) | \(BotLook.describe(id: row.bot.id, name: row.bot.name, avatar: row.bot.avatar))")
        }
        for row in d.attention {
            let link = Rules.openURL(botId: row.bot.id)?.absoluteString ?? "-"
            print("ATTENTION \(row.account.rawValue) | \(row.bot.name) | \(row.state.label) | \(Rules.openLabel(row.account)) | \(link)")
        }
        for session in d.sessions + d.orphans {
            print("SESSION \(Sessions.toolLabel(session)) | \(Sessions.title(session)) | \(Sessions.statusLabel(session)) | started by \(d.ownerName(of: session))")
        }
        for usage in Usage.sorted(state.accounts) {
            let meters = usage.meters.map { m -> String in
                if m.noLimit { return "\(m.label) no limit" }
                guard let used = m.pctUsed else { return "\(m.label) –" }
                return "\(m.label) \(Int(used.rounded()))% used"
            }
            print("USAGE \(Usage.displayName(usage)) | \(meters.joined(separator: ", "))")
        }
        for grok in state.grok {
            print("GROK \(grok.account.label) | \(Int(grok.pctUsed.rounded()))% used | \(grok.bots.count) bots")
        }
    }
}
