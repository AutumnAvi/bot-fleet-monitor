import SwiftUI

// MARK: Focus card

/// The bot on screen: who it is and why it needs Avi, what it is doing, the coding sessions it
/// started, what it said lately, then Open chat, its PR and Next.
struct FocusCard: View {
    let row: BotRow
    let d: FleetDerived
    let next: BotRow?
    /// Puts another bot (`account:id`) on the card.
    let onFocus: (String) -> Void

    @Environment(\.widthClass) private var widthClass

    private var tone: Tone { row.state.tone }
    private var botSessions: [CodingSession] { d.sessions(for: row.bot) }
    private var activity: [ActivityItem] { d.activity(for: row.bot) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            band
            // Two columns when the card is wide enough; always stacked in narrow windows.
            Group {
                if widthClass == .narrow {
                    stacked
                } else {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .top, spacing: 24) {
                            happening.frame(minWidth: 260, idealWidth: 300, maxWidth: .infinity, alignment: .topLeading)
                            recent.frame(minWidth: 240, idealWidth: 280, maxWidth: .infinity, alignment: .topLeading)
                        }
                        stacked
                    }
                }
            }
            .padding(20)
            footer
        }
        .card()
    }

    private var stacked: some View {
        VStack(alignment: .leading, spacing: 18) {
            happening
            recent
        }
    }

    private var band: some View {
        HStack(spacing: 14) {
            Avatar(name: row.bot.name, tone: tone, size: 52)
            VStack(alignment: .leading, spacing: 5) {
                Text(row.bot.name).font(.system(size: 20, weight: .bold)).foregroundStyle(Theme.text).lineLimit(2)
                HStack(spacing: 6) {
                    AccountTag(account: row.account)
                    Text(subtitle).font(Theme.F.body).foregroundStyle(Theme.text2).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            StateBadge(row: row, now: d.now)
                .padding(.horizontal, 5).padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 7).fill(Theme.surface))
                .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Theme.fill(tone)))
        }
        .padding(.horizontal, 20).padding(.vertical, 16)
        .background(Theme.tint(tone))
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    /// "Apps · stuck since 12:41 PM (Hebron)".
    private var subtitle: String {
        let group = Rules.groupName(row.bot.group)
        let since: String?
        switch row.state {
        case .error: since = row.bot.statusAt.map { "stuck since \(Fmt.clockOrDate($0, now: d.now)) (Hebron)" }
        case .waitingUser: since = row.bot.statusAt.map { "waiting since \(Fmt.clockOrDate($0, now: d.now)) (Hebron)" }
        case .stale: since = Rules.lastSeenAt(row.bot).map { "last report \(Fmt.clockOrDate($0, now: d.now)) (Hebron)" }
        default: since = nil
        }
        return since.map { "\(group) · \($0)" } ?? group
    }

    private var happening: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "What's happening")
            Text(row.step).font(.system(size: 15)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
            if let seen = Rules.lastSeenAt(row.bot) {
                let age = Fmt.age(seen, now: d.now)
                let ago = age == "now" ? "just now" : age + " ago"
                caption("Last report \(Fmt.clockOrDate(seen, now: d.now)) · \(ago)")
            }
            ForEach(Array(botSessions.prefix(2)), id: \.id) { session in
                sessionBox(session)
            }
        }
    }

    /// A session this bot started: tool, title, status, progress, then runtime · PR · CI · pool.
    private func sessionBox(_ s: CodingSession) -> some View {
        let tone = Sessions.tone(s)
        let status = Sessions.stepText(s).map { "\(Sessions.statusLabel(s)) \($0)" } ?? Sessions.statusLabel(s)
        var parts = ["\(Sessions.runtime(s, now: d.now)) run"]
        if let pr = s.prUrl { parts.append(Sessions.prLabel(pr)) }
        if let ci = s.ci { parts.append("CI \(ci.state)") }
        parts.append(Sessions.poolName(s))
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ToolBadge(session: s)
                Text("Coding session it started · \(Sessions.title(s))")
                    .font(Theme.F.bodyBold).foregroundStyle(Theme.text).lineLimit(2)
                Spacer(minLength: 6)
                Pill(text: status, tone: tone)
            }
            if let progress = Sessions.progress(s) {
                Bar(fraction: progress, tone: tone, height: 5)
            }
            Text(parts.joined(separator: " · ")).font(Theme.F.caption).foregroundStyle(Theme.text2).lineLimit(2)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line))
    }

    private var recent: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: activity.isEmpty ? "Recent from this bot" : "Recent from this bot · \(activity.count)")
            if activity.isEmpty {
                Text("No recent updates in the feed.").font(Theme.F.small).foregroundStyle(Theme.text3)
            }
            ForEach(Array(activity.prefix(3)), id: \.seq) { item in
                activityBlock(item)
            }
            if row.bot.unread > 0 {
                caption("\(FocusText.plural(row.bot.unread, "message")) since your last reply")
            }
            if let at = row.bot.lastAviReplyAt {
                caption("Your last reply · \(Fmt.full(at))")
            }
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text).font(Theme.F.caption).foregroundStyle(Theme.text3)
    }

    /// One feed item with a coloured left edge. A message shows its first 80 characters, quoted.
    private func activityBlock(_ item: ActivityItem) -> some View {
        let text: String
        if item.kind == "message", let detail = item.detail {
            text = "“\(detail)”"
        } else {
            text = Rules.activityText(kind: item.kind, detail: item.detail)
        }
        return VStack(alignment: .leading, spacing: 3) {
            Text(Fmt.clockOrDate(item.at, now: d.now)).font(Theme.F.caption).foregroundStyle(Theme.text3)
            Text(text).font(Theme.F.body).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, 15).padding(.trailing, 12).padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface2)
        .overlay(alignment: .leading) {
            Rectangle().fill(Theme.fill(Rules.activityTone(kind: item.kind))).frame(width: 3)
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    /// The first https PR link among the bot's sessions.
    private var prLink: (label: String, url: URL)? {
        for session in botSessions {
            if let raw = session.prUrl, let url = Sessions.safeURL(raw) { return (Sessions.prLabel(raw), url) }
        }
        return nil
    }

    private var footer: some View {
        HStack(spacing: 10) {
            OpenChatButton(bot: row.bot)
            if let pr = prLink {
                LinkButton(title: pr.label, url: pr.url)
            }
            Spacer(minLength: 8)
            if let next {
                Button {
                    onFocus(next.key)
                } label: {
                    HStack(spacing: 4) {
                        Text(widthClass == .narrow ? "Next" : "Next: \(next.bot.name)").lineLimit(1)
                        Text("›")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .keyboardShortcut("n", modifiers: [])
                .help("Show the next bot that needs you (N)")
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface2)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }
}
