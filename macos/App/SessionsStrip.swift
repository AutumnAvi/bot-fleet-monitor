import AppKit
import SwiftUI

/// One line under the usage bars on every tab: "⌨ [3 running] [T3 Reply drafts 4/6 ◆] … +2".
/// Coding sessions from the box collector, each with the bot that started it. FYI only: a session
/// is never a Needs-my-attention item and has no Open chat. Click to expand the list in place.
/// Hidden when no session ran in the last 24 hours.
struct SessionsStrip: View {
    let d: FleetDerived
    @Environment(\.widthClass) private var width
    @State private var expanded = false

    static let windowMs: Double = 24 * 60 * 60 * 1000

    /// Active sessions, plus any that changed in the last 24 hours. Orphans only under All.
    static func recent(_ d: FleetDerived) -> [CodingSession] {
        Sessions.sorted((d.sessions + d.orphans).filter { Sessions.isActive($0) || d.now - $0.updatedAt < Self.windowMs })
    }

    private var chipLimit: Int { width == .narrow ? 1 : width == .regular ? 3 : 5 }

    var body: some View {
        let all = Self.recent(d)
        if !all.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Button { expanded.toggle() } label: { line(all) }
                    .buttonStyle(PlainRowButtonStyle())
                    .help(expanded ? "Hide coding sessions" : "Show every coding session")
                if expanded {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(all.enumerated()), id: \.element.id) { index, session in
                                if index > 0 { Divider().overlay(Theme.line) }
                                SessionRow(session: session, owner: d.ownerName(of: session),
                                           ownerBot: d.owner(of: session), now: d.now)
                            }
                        }
                        .padding(.horizontal, 16).padding(.bottom, 6)
                    }
                    .frame(maxHeight: 300)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface2)
            .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
        }
    }

    private func line(_ all: [CodingSession]) -> some View {
        let running = all.filter(Sessions.isLive).count
        let shown = Array(all.prefix(chipLimit))
        return HStack(spacing: 8) {
            Image(systemName: "keyboard").font(.system(size: 11)).foregroundStyle(Theme.text2)
            Pill(text: running == 0 ? "none running" : "\(running) running", tone: running == 0 ? .gray : .blue, bold: true)
            ForEach(shown, id: \.id) { session in chip(session) }
            if all.count > shown.count {
                Text("+\(all.count - shown.count)").font(Theme.F.smallBold).foregroundStyle(Theme.text2).fixedSize()
            }
            Spacer(minLength: 6)
            Image(systemName: expanded ? "chevron.up" : "chevron.down")
                .font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.text3)
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// Tool, short title, step x/y and the starting bot's symbol.
    private func chip(_ s: CodingSession) -> some View {
        HStack(spacing: 5) {
            ToolBadge(session: s)
            Text(s.title).font(Theme.F.small).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: width == .narrow ? 150 : 180, alignment: .leading)
            if let step = Sessions.stepText(s) {
                Text(step).font(Theme.F.caption).monospacedDigit().foregroundStyle(Theme.fg(Sessions.tone(s))).fixedSize()
            }
            if let owner = d.owner(of: s) {
                BotSymbol(bot: owner, size: 13)
            }
        }
        .padding(.horizontal, 7).padding(.vertical, 3)
        .background(Capsule().fill(Theme.surface))
        .overlay(Capsule().strokeBorder(Theme.line))
        .help("\(Sessions.title(s)) · \(Sessions.statusLabel(s)) · started by \(d.ownerName(of: s))")
    }
}

/// One session: tool badge, title, status; then "started by <bot>", progress, and runtime or reset.
struct SessionRow: View {
    let session: CodingSession
    let owner: String
    var ownerBot: Bot?
    let now: Double

    private var link: URL? { Sessions.safeURL(session.prUrl) ?? Sessions.safeURL(session.agentUrl) }

    @ViewBuilder var body: some View {
        if let link {
            Button { NSWorkspace.shared.open(link) } label: { content }
                .buttonStyle(PlainRowButtonStyle())
                .help(helpText(link))
        } else {
            content.help(helpText(nil))
        }
    }

    private var content: some View {
        let tone = Sessions.tone(session)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                ToolBadge(session: session)
                Text(Sessions.title(session))
                    .font(Theme.F.bodyBold)
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let badge = Sessions.attentionBadge(session), badge != Sessions.statusLabel(session) {
                    Pill(text: badge, tone: session.attentionReason == "pr_ready" ? .green : .amber)
                }
                Spacer(minLength: 6)
                Text(Sessions.statusLabel(session))
                    .font(Theme.F.smallBold)
                    .foregroundStyle(Theme.fg(tone))
                    .lineLimit(1)
                    .fixedSize()
            }
            HStack(spacing: 6) {
                Text("started by").foregroundStyle(Theme.text3)
                if let ownerBot { BotSymbol(bot: ownerBot, size: 12) }
                Text(owner).foregroundStyle(Theme.text2).lineLimit(1).truncationMode(.tail)
                if let progress = Sessions.progress(session) {
                    Bar(fraction: progress, tone: tone, height: 3).frame(width: 56)
                    if let step = Sessions.stepText(session) {
                        Text(step).foregroundStyle(Theme.text3).monospacedDigit().fixedSize()
                    }
                }
                Spacer(minLength: 6)
                Text(trailing).foregroundStyle(Theme.text3).monospacedDigit().lineLimit(1).fixedSize()
            }
            .font(Theme.F.caption)
        }
        .padding(.vertical, 7)
        .contentShape(Rectangle())
    }

    /// Runtime, or "↻ 2:10 PM" for a session paused on a usage limit.
    private var trailing: String {
        if Sessions.displayStatus(session) == "paused_limit", let reset = session.limitReset {
            return "↻ \(Fmt.reset(reset, now: now))"
        }
        return Sessions.runtime(session, now: now)
    }

    private func helpText(_ link: URL?) -> String {
        var parts = [Sessions.poolName(session)]
        if let repo = session.repo { parts.append(session.branch.map { "\(repo) · \($0)" } ?? repo) }
        if let model = session.model { parts.append(session.effort.map { "\(model) · \($0)" } ?? model) }
        if let ci = session.ci { parts.append("CI \(ci.state)") }
        if let link { parts.append("Click to open \(link.host ?? "link")") }
        return parts.joined(separator: "\n")
    }
}

/// "T3" / "Cursor" on black, "Claude" on orange, others on grey.
struct ToolBadge: View {
    let session: CodingSession

    var body: some View {
        let label = Sessions.toolLabel(session)
        Text(label)
            .font(.system(size: 10.5, weight: .bold))
            .foregroundStyle(label == "Claude" || label == "T3" || label == "Cursor" ? Color.white : Theme.text)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(RoundedRectangle(cornerRadius: 4).fill(fill(label)))
            .lineLimit(1)
            .fixedSize()
    }

    private func fill(_ label: String) -> Color {
        switch label {
        case "Claude": return Color(hex: 0xD97757)
        case "T3", "Cursor": return Color(hex: 0x111214)
        default: return Theme.tint(.gray)
        }
    }
}
