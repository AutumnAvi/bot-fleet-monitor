import SwiftUI

// A bot's small symbol: its Grok Bot look (`avatar {shape, color}`), or its initials on a colour
// hashed from its id. Identity only; the status keeps its own badge and colours.

enum BotLook {
    enum Shape: String {
        case blob, hex, star, cloud, teardrop, tablet, wedge, pebble

        /// SF Symbol for the shapes drawn as symbols; nil for the ones drawn as SwiftUI shapes.
        var symbol: String? {
            switch self {
            case .hex: return "hexagon.fill"
            case .star: return "star.fill"
            case .cloud: return "cloud.fill"
            case .teardrop: return "drop.fill"
            case .wedge: return "triangle.fill"
            case .blob, .tablet, .pebble: return nil
            }
        }
    }

    static func shape(_ raw: String?) -> Shape? { raw.flatMap(Shape.init(rawValue:)) }

    /// The Grok Bot colour names. Black turns light grey in dark mode so it stays visible.
    static func color(_ raw: String?) -> Color? {
        switch raw {
        case "red": return Color(hex: 0xEF4444)
        case "yellow": return Color(hex: 0xEAB308)
        case "orange": return Color(hex: 0xF97316)
        case "cyan": return Color(hex: 0x06B6D4)
        case "brown": return Color(hex: 0x92603A)
        case "black": return Color(light: 0x1F2937, dark: 0xD1D5DB)
        case "blue": return Color(hex: 0x3B82F6)
        case "green": return Color(hex: 0x22A35A)
        case "purple": return Color(hex: 0x8B5CF6)
        case "pink": return Color(hex: 0xEC4899)
        case "gray": return Color(hex: 0x9CA3AF)
        default: return nil
        }
    }

    private static let palette: [UInt32] = [
        0x0EA5E9, 0x6366F1, 0x14B8A6, 0xF97316, 0xA855F7, 0xEC4899, 0x64748B, 0x65A30D, 0xB45309,
    ]

    /// Stable across launches (FNV-1a over the id; Swift's hashValue is seeded per process).
    static func paletteIndex(_ id: String) -> Int {
        var hash: UInt32 = 2_166_136_261
        for byte in id.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 16_777_619
        }
        return Int(hash % UInt32(palette.count))
    }

    static func hashed(_ id: String) -> Color { Color(hex: palette[paletteIndex(id)]) }

    /// "star black", or "initials CR #3" for CI's log.
    static func describe(id: String, name: String, avatar: BotAvatar?) -> String {
        if let shape = shape(avatar?.shape) {
            return "\(shape.rawValue) \(color(avatar?.color) == nil ? "hashed" : avatar?.color ?? "")"
        }
        return "initials \(Rules.initials(name)) #\(paletteIndex(id))"
    }
}

struct BotSymbol: View {
    let id: String
    let name: String
    let avatar: BotAvatar?
    var size: CGFloat = 16
    /// Draw the shape on a rounded tile (the Focus card and Feed rows).
    var tile = false

    init(bot: Bot, size: CGFloat = 16, tile: Bool = false) {
        self.init(id: bot.id, name: bot.name, avatar: bot.avatar, size: size, tile: tile)
    }

    init(id: String, name: String, avatar: BotAvatar?, size: CGFloat = 16, tile: Bool = false) {
        self.id = id
        self.name = name
        self.avatar = avatar
        self.size = size
        self.tile = tile
    }

    var body: some View {
        Group {
            if let shape = BotLook.shape(avatar?.shape) {
                let color = BotLook.color(avatar?.color) ?? BotLook.hashed(id)
                if tile {
                    ZStack {
                        RoundedRectangle(cornerRadius: size * 0.24).fill(Theme.surface)
                        RoundedRectangle(cornerRadius: size * 0.24).strokeBorder(Theme.line)
                        drawn(shape, color: color, box: size * 0.6)
                    }
                } else {
                    drawn(shape, color: color, box: size)
                }
            } else {
                Text(Rules.initials(name))
                    .font(.system(size: size * 0.4, weight: .bold))
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                    .foregroundStyle(.white)
                    .frame(width: size, height: size)
                    .background(RoundedRectangle(cornerRadius: size * 0.26).fill(BotLook.hashed(id)))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    @ViewBuilder private func drawn(_ shape: BotLook.Shape, color: Color, box: CGFloat) -> some View {
        switch shape {
        case .blob:
            Circle().fill(color).frame(width: box * 0.86, height: box * 0.86)
        case .tablet:
            RoundedRectangle(cornerRadius: box * 0.16).fill(color).frame(width: box * 0.68, height: box * 0.9)
        case .pebble:
            Capsule().fill(color).frame(width: box * 0.94, height: box * 0.58)
        default:
            Image(systemName: shape.symbol ?? "circle.fill")
                .resizable().scaledToFit()
                .foregroundStyle(color)
                .frame(width: box * 0.9, height: box * 0.9)
        }
    }
}
