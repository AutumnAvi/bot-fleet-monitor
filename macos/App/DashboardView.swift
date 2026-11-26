import AppKit
import SwiftUI

/// The Bot Fleet window. Native SwiftUI over GET /api/v1/state; there is no web view, so a
/// Screen Time filter on *.workers.dev in Safari/WebKit does not affect it.
struct DashboardView: View {
    @ObservedObject var model: FleetModel

    var body: some View {
        Group {
            if model.needsSetup {
                SetupView(model: model)
            } else if model.problem == .notV2 {
                MissingV2View(model: model)
            } else if let state = model.state {
                FleetWindow(model: model, state: state)
            } else if let problem = model.problem {
                ProblemView(model: model, problem: problem)
            } else {
                ConnectingView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .sheet(isPresented: $model.showSettings) {
            SettingsView(model: model)
        }
    }
}

/// Top bar, connection banner, switch banner, then Monitor; or the usage bars, coding sessions strip
/// and the selected secondary tab. Reflows by window width.
struct FleetWindow: View {
    @ObservedObject var model: FleetModel
    let state: FleetState

    var body: some View {
        GeometryReader { geo in
            let d = FleetDerived(state: state, filter: model.filter, now: model.now)
            VStack(spacing: 0) {
                TopBar(model: model, d: d)
                if let problem = model.problem {
                    StatusBanner(model: model, problem: problem)
                }
                if let banner = MonitorRules.banner(MonitorRules.accounts(state, now: model.now), now: model.now) {
                    SwitchBannerView(banner: banner)
                }
                if model.tab == .monitor {
                    MonitorView(model: model, d: d, state: state)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                } else {
                    UsageStrip(state: state, now: model.now)
                    SessionsStrip(d: d)
                    Rectangle().fill(Theme.line).frame(height: 1)
                    Group {
                        switch model.tab {
                        case .monitor: EmptyView()
                        case .focus: FocusView(model: model, d: d)
                        case .board: BoardView(model: model, d: d)
                        case .feed: FeedView(model: model, d: d)
                        case .later: LaterView(model: model, d: d)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                }
            }
            .environment(\.widthClass, WidthClass(width: geo.size.width))
            .overlay(alignment: .bottom) { SaveToastView(model: model) }
            .animation(.easeOut(duration: 0.2), value: model.toast)
        }
        .background(Theme.bg)
    }
}

/// Shown above the data when the last read failed. The data below is the last good read.
struct StatusBanner: View {
    @ObservedObject var model: FleetModel
    let problem: FetchProblem

    var body: some View {
        let tone: Tone = problem == .unauthorized || problem == .decode ? .red : .amber
        HStack(spacing: 10) {
            Image(systemName: problem == .unauthorized ? "key.slash" : "wifi.exclamationmark")
                .foregroundStyle(Theme.fg(tone))
            VStack(alignment: .leading, spacing: 1) {
                Text("\(problem.title) — \(problem.detail)")
                    .font(Theme.F.bodyBold)
                    .foregroundStyle(Theme.fg(tone))
                    .lineLimit(2)
                Text(since)
                    .font(Theme.F.small)
                    .foregroundStyle(Theme.text2)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Button("Retry") { Task { await model.refresh() } }
                .buttonStyle(SecondaryButtonStyle(compact: true))
            Button("Settings…") { model.showSettings = true }
                .buttonStyle(SecondaryButtonStyle(compact: true))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Theme.tint(tone))
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.fill(tone).opacity(0.5)).frame(height: 1) }
    }

    private var since: String {
        guard let last = model.lastSuccess else { return "Retrying every \(Int(FleetModel.pollSeconds)) seconds." }
        let at = last.timeIntervalSince1970 * 1000
        let age = Fmt.age(at, now: model.now)
        let ago = age == "now" ? "just now" : "\(age) ago"
        return "Showing what Fleet said at \(Fmt.clock(at)) (\(ago)). Retrying every \(Int(FleetModel.pollSeconds)) seconds."
    }
}

/// No data yet and the first read failed (offline, refused key, server error).
struct ProblemView: View {
    @ObservedObject var model: FleetModel
    let problem: FetchProblem

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 30))
                .foregroundStyle(Theme.fg(.amber))
            Text(heading)
                .font(Theme.F.display)
                .foregroundStyle(Theme.text)
            Text(problem.detail)
                .font(Theme.F.body)
                .foregroundStyle(Theme.text2)
                .fixedSize(horizontal: false, vertical: true)
            if let base = BaseURL.saved {
                Text(base.absoluteString)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Theme.text3)
                    .textSelection(.enabled)
            }
            Text("The app checks again every \(Int(FleetModel.pollSeconds)) seconds.")
                .font(Theme.F.small)
                .foregroundStyle(Theme.text3)
            HStack {
                Button("Try again") { Task { await model.refresh() } }
                    .buttonStyle(PrimaryButtonStyle())
                    .keyboardShortcut(.defaultAction)
                Button("Settings…") { model.showSettings = true }
                    .buttonStyle(SecondaryButtonStyle())
            }
        }
        .padding(32)
        .frame(maxWidth: 520, alignment: .leading)
        .card()
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var heading: String {
        switch problem {
        case .offline: return "Can't reach Fleet"
        case .unauthorized: return "Fleet refused the read key"
        default: return problem.title
        }
    }

    private var icon: String {
        switch problem {
        case .offline: return "wifi.exclamationmark"
        case .unauthorized: return "key.slash"
        default: return "exclamationmark.triangle"
        }
    }
}

struct ConnectingView: View {
    var body: some View {
        VStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text("Reading Fleet…").font(Theme.F.body).foregroundStyle(Theme.text2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
