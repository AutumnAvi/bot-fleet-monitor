import AppKit
import SwiftUI

/// "⌨ Coding sessions" — Claude Code, T3 and Cursor runs from the box collector, each with the bot
/// that started it. FYI only: a session is never a Needs-my-attention item and has no Open chat.
struct SessionsPanel: View {
    let d: FleetDerived
    /// Rows shown before "+N more".
    var limit = 6
    /// Narrow windows start with the panel folded into one line.
    var startCollapsed = false

    @State private var expanded = false
    @State private var showAll = false

    private var all: [CodingSession] { d.sessions }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if isOpen {
                if all.isEmpty && d.orphans.isEmpty {
                    Text("No coding sessions right now.")
                        .font(Theme.F.small)
                        .foregroundStyle(Theme.text3)
                        .padding(.top, 8)
                }
                ForEach(Array(shown.enumerated()), id: \.element.id) { index, session in
                    if index > 0 { Divider().overlay(Theme.line) }
                    SessionRow(session: session, owner: d.ownerName(of: session), now: d.now)
                }
                footer
            }
        }
        .padding(12)
        .card(fill: Theme.surface2)
    }

    private var isOpen: Bool { !startCollapsed || expanded }
    private var shown: [CodingSession] { showAll ? all : Array(all.prefix(limit)) }

    @ViewBuilder private var header: some View {
        if startCollapsed {
            Button { expanded.toggle() } label: { headerLine }
                .buttonStyle(PlainRowButtonStyle())
        } else {
            headerLine
        }
    }

    private var headerLine: some View {
        HStack(spacing: 6) {
            Image(systemName: "keyboard").font(.system(size: 11)).foregroundStyle(Theme.text2)
            Text("Coding sessions").font(Theme.F.bodyBold).foregroundStyle(Theme.text)
            if !isOpen {
                Text("· \(Sessions.summary(all))").font(Theme.F.small).foregroundStyle(Theme.text3).lineLimit(1)
            }
            Spacer(minLength: 8)
            if isOpen {
                Text("started by bots · FYI only").font(Theme.F.caption).foregroundStyle(Theme.text3).lineLimit(1)
            }
            if startCollapsed {
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.text3)
            }
        }
        .padding(.bottom, isOpen ? 6 : 0)
    }

    @ViewBuilder private var footer: some View {
        let extra = all.count - shown.count
        let orphanText = orphanLine
        if extra > 0 || orphanText != nil || (showAll && all.count > limit) {
            HStack(spacing: 4) {
                if extra > 0 {
                    Button("+\(extra) more") { showAll = true }
                        .buttonStyle(PlainRowButtonStyle())
                        .foregroundStyle(Theme.fg(.blue))
                } else if showAll && all.count > limit {
                    Button("Show fewer") { showAll = false }
                        .buttonStyle(PlainRowButtonStyle())
                        .foregroundStyle(Theme.fg(.blue))
                }
                if let orphanText {
                    if extra > 0 || showAll { Text("·").foregroundStyle(Theme.text3) }
                    Text(orphanText).foregroundStyle(Theme.text3).lineLimit(1).truncationMode(.tail)
                }
            }
            .font(Theme.F.caption)
            .padding(.top, 8)
        }
    }

    /// "1 session with no bot found (Claude CLI ~/scratch)".
    private var orphanLine: String? {
        let orphans = d.orphans
        guard let first = orphans.first else { return nil }
        if orphans.count == 1 { return "1 session with no bot found (\(first.title))" }
        return "\(orphans.count) sessions with no bot found"
    }
}

/// One session: tool badge, title, status; then "started by <bot>", progress, and runtime or reset.
struct SessionRow: View {
    let session: CodingSession
    let owner: String
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
