import AppKit
import SwiftUI

// Design tokens for the option-8 design (mockups: Focus, Board, Feed). Light values follow the
// mockups; dark values keep the same hues. Every control here is drawn by SwiftUI (no AppKit
// buttons), so CI snapshots render it.

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255,
                  blue: Double(hex & 255) / 255, opacity: 1)
    }

    /// Light/dark pair resolved by the view's appearance.
    init(light: UInt32, dark: UInt32) {
        func ns(_ h: UInt32) -> NSColor {
            NSColor(srgbRed: CGFloat((h >> 16) & 255) / 255, green: CGFloat((h >> 8) & 255) / 255,
                    blue: CGFloat(h & 255) / 255, alpha: 1)
        }
        self.init(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? ns(dark) : ns(light) })
    }
}

enum Theme {
    static let bg = Color(light: 0xF3F4F6, dark: 0x111214)
    static let surface = Color(light: 0xFFFFFF, dark: 0x1B1C1F)
    static let surface2 = Color(light: 0xF7F8FA, dark: 0x222428)
    static let column = Color(light: 0xE9EAEE, dark: 0x18191C)
    static let line = Color(light: 0xE5E7EB, dark: 0x2D3036)
    static let text = Color(light: 0x111827, dark: 0xE9EAEC)
    static let text2 = Color(light: 0x4B5563, dark: 0xA6AAB1)
    static let text3 = Color(light: 0x9CA3AF, dark: 0x7D828A)
    /// The dark top bar is dark in both appearances.
    static let bar = Color(hex: 0x15161A)
    static let barRaised = Color(hex: 0x2A2B31)
    static let barLine = Color(hex: 0x3A3B42)
    static let barText = Color(hex: 0xF3F4F6)
    static let barText2 = Color(hex: 0xA1A1AA)
    /// "Open chat" and other primary buttons.
    static let ink = Color(light: 0x111214, dark: 0xF3F4F6)
    static let onInk = Color(light: 0xFFFFFF, dark: 0x111214)

    static func fg(_ tone: Tone) -> Color {
        switch tone {
        case .red: return Color(light: 0xDC2626, dark: 0xFF7D8C)
        case .amber: return Color(light: 0xB45309, dark: 0xF0B24A)
        case .pink: return Color(light: 0x6B7280, dark: 0xC0C4CA)
        case .blue: return Color(light: 0x2563EB, dark: 0x7AA7FF)
        case .green: return Color(light: 0x15803D, dark: 0x4CC77F)
        case .violet: return Color(light: 0x6D28D9, dark: 0xB9A2FF)
        case .gray: return Color(light: 0x6B7280, dark: 0xA6AAB1)
        case .sky: return Color(light: 0x0369A1, dark: 0x7DD3FC)
        case .indigo: return Color(light: 0x4338CA, dark: 0xA5B4FC)
        }
    }

    static func tint(_ tone: Tone) -> Color {
        switch tone {
        case .red: return Color(light: 0xFEE2E2, dark: 0x3B1D23)
        case .amber: return Color(light: 0xFEF3C7, dark: 0x372C15)
        case .pink: return Color(light: 0xF3F4F6, dark: 0x2A2C31)
        case .blue: return Color(light: 0xDBEAFE, dark: 0x1B2A45)
        case .green: return Color(light: 0xD1FAE5, dark: 0x123326)
        case .violet: return Color(light: 0xEDE9FE, dark: 0x2A2145)
        case .gray: return Color(light: 0xF3F4F6, dark: 0x2A2C31)
        case .sky: return Color(light: 0xEFF6FF, dark: 0x13253A)
        case .indigo: return Color(light: 0xE0E7FF, dark: 0x26294A)
        }
    }

    /// Solid fills for bars, dots and card edges. Readable on light and dark.
    static func fill(_ tone: Tone) -> Color {
        switch tone {
        case .red: return Color(hex: 0xEF4444)
        case .amber: return Color(hex: 0xF59E0B)
        case .pink: return Color(hex: 0xF9A8B4)
        case .blue: return Color(hex: 0x3B82F6)
        case .green: return Color(hex: 0x22A35A)
        case .violet: return Color(hex: 0x8B5CF6)
        case .gray: return Color(hex: 0x9CA3AF)
        case .sky: return Color(hex: 0x0EA5E9)
        case .indigo: return Color(hex: 0x6366F1)
        }
    }

    /// Avi's Work is indigo, Admin is green.
    static func accountTone(_ account: FleetAccount) -> Tone { account == .work ? .indigo : .green }

    enum F {
        static let display = Font.system(size: 22, weight: .bold)
        static let title = Font.system(size: 17, weight: .semibold)
        static let cardTitle = Font.system(size: 15, weight: .semibold)
        static let body = Font.system(size: 13.5)
        static let bodyBold = Font.system(size: 13.5, weight: .semibold)
        static let small = Font.system(size: 12)
        static let smallBold = Font.system(size: 12, weight: .semibold)
        static let caption = Font.system(size: 11)
        static let label = Font.system(size: 11, weight: .semibold)
        static let big = Font.system(size: 20, weight: .bold)
    }

    static let radius: CGFloat = 12
}

/// Window width class. The design reflows at these widths: one column, two, or three.
enum WidthClass: Hashable {
    case narrow, regular, wide

    init(width: CGFloat) {
        if width < 900 { self = .narrow } else if width < 1500 { self = .regular } else { self = .wide }
    }
}

private struct WidthClassKey: EnvironmentKey {
    static let defaultValue = WidthClass.regular
}

extension EnvironmentValues {
    var widthClass: WidthClass {
        get { self[WidthClassKey.self] }
        set { self[WidthClassKey.self] = newValue }
    }
}

// MARK: Small pieces

/// Indigo "Avi's Work" or green "Admin".
struct AccountTag: View {
    let account: FleetAccount
    var body: some View {
        Pill(text: account.label, tone: Theme.accountTone(account), bold: true)
    }
}

/// Rounded label on a tint: state badges, "Saved 9:48", "PR ready".
struct Pill: View {
    let text: String
    let tone: Tone
    var bold = false
    var uppercase = false

    var body: some View {
        Text(uppercase ? text.uppercased() : text)
            .font(.system(size: uppercase ? 10.5 : 11, weight: bold || uppercase ? .semibold : .medium))
            .tracking(uppercase ? 0.3 : 0)
            .lineLimit(1)
            .foregroundStyle(Theme.fg(tone))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 5).fill(Theme.tint(tone)))
            .fixedSize()
    }
}

/// "STUCK", "Needs me", "Stale 23m".
struct StateBadge: View {
    let row: BotRow
    let now: Double
    var uppercase = true

    var body: some View {
        Pill(text: text, tone: row.state.tone, uppercase: uppercase)
    }

    private var text: String {
        if row.state == .stale, let seen = Rules.lastSeenAt(row.bot) { return "Stale \(Fmt.duration(now - seen))" }
        return row.state.label
    }
}

/// Uppercase grey section heading: "UP NEXT", "SAVED FOR LATER · 1".
struct SectionLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 11, weight: .semibold))
            .tracking(0.6)
            .foregroundStyle(Theme.text2)
            .lineLimit(1)
    }
}

struct Dot: View {
    let tone: Tone
    var size: CGFloat = 8
    var body: some View {
        Circle().fill(Theme.fill(tone)).frame(width: size, height: size)
    }
}

/// Thin meter. `fraction` is 0–1.
struct Bar: View {
    let fraction: Double?
    let tone: Tone
    var height: CGFloat = 4
    var track: Color = Theme.line

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(track)
                Capsule()
                    .fill(Theme.fill(tone))
                    .frame(width: g.size.width * CGFloat(min(max(fraction ?? 0, 0), 1)))
            }
        }
        .frame(height: height)
    }
}

/// Initials in a rounded square (focus card) or circle (feed).
struct Avatar: View {
    let name: String
    let tone: Tone
    var size: CGFloat = 36
    var circle = false

    var body: some View {
        Text(Rules.initials(name))
            .font(.system(size: size * 0.36, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(
                RoundedRectangle(cornerRadius: circle ? size / 2 : size * 0.22).fill(Theme.fill(tone))
            )
    }
}

/// White card with a hairline border. `edge` draws the coloured top edge from the Board design.
struct CardBackground: ViewModifier {
    var edge: Tone?
    var fill: Color = Theme.surface
    var dashed = false

    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: Theme.radius).fill(fill))
            .overlay(alignment: .top) {
                if let edge {
                    UnevenRoundedRectangle(topLeadingRadius: Theme.radius, topTrailingRadius: Theme.radius)
                        .fill(Theme.fill(edge))
                        .frame(height: 3)
                }
            }
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radius)
                    .strokeBorder(Theme.line, style: StrokeStyle(lineWidth: 1, dash: dashed ? [4, 3] : []))
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
    }
}

extension View {
    func card(edge: Tone? = nil, fill: Color = Theme.surface, dashed: Bool = false) -> some View {
        modifier(CardBackground(edge: edge, fill: fill, dashed: dashed))
    }
}

// MARK: Buttons

/// Black capsule ("Open chat ↗", "Next ›").
struct PrimaryButtonStyle: ButtonStyle {
    var compact = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: compact ? 12 : 13.5, weight: .semibold))
            .foregroundStyle(Theme.onInk)
            .padding(.horizontal, compact ? 10 : 16)
            .padding(.vertical, compact ? 4 : 8)
            .background(RoundedRectangle(cornerRadius: compact ? 6 : 9).fill(Theme.ink))
            .opacity(configuration.isPressed ? 0.75 : 1)
            .contentShape(Rectangle())
    }
}

/// White outlined button ("PR #31 ↗").
struct SecondaryButtonStyle: ButtonStyle {
    var compact = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: compact ? 12 : 13.5, weight: .medium))
            .foregroundStyle(Theme.text)
            .padding(.horizontal, compact ? 9 : 14)
            .padding(.vertical, compact ? 4 : 8)
            .background(RoundedRectangle(cornerRadius: compact ? 6 : 9).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: compact ? 6 : 9).strokeBorder(Theme.line))
            .opacity(configuration.isPressed ? 0.7 : 1)
            .contentShape(Rectangle())
    }
}

/// Text-only button (rows, chips, "Show all").
struct PlainRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

/// Opens the bot's Grok chat (grokbot://app/v1/agent?id=…). The label always names the account,
/// because the link opens whichever Grok Bot account the app is signed into.
struct OpenChatButton: View {
    let bot: Bot
    var compact = false

    var body: some View {
        Button {
            if let url = Rules.openURL(botId: bot.id) { NSWorkspace.shared.open(url) }
        } label: {
            Text("\(Rules.openLabel(bot.account)) ↗").lineLimit(1).fixedSize()
        }
        .buttonStyle(PrimaryButtonStyle(compact: compact))
        .help("Opens \(bot.name) in Grok Bot. Make sure Grok Bot is signed into \(bot.account.label).")
        .accessibilityLabel("Open \(bot.name) chat in \(bot.account.label)")
    }
}

/// Opens an https link (a PR, a CI run) in the default browser.
struct LinkButton: View {
    let title: String
    let url: URL
    var compact = false

    var body: some View {
        Button {
            NSWorkspace.shared.open(url)
        } label: {
            Text("\(title) ↗").lineLimit(1).fixedSize()
        }
        .buttonStyle(SecondaryButtonStyle(compact: compact))
        .help(url.absoluteString)
    }
}

/// Wraps rows of chips onto as many lines as they need.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                y += line + lineSpacing
                x = 0
                line = 0
            }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += line + lineSpacing
                x = bounds.minX
                line = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}
