import SwiftUI

// Save for later from the app: "Later" on what needs Avi, "Move back" on saved bots, and the toast
// with Undo. Shown only when Settings has a control key.

/// "Later" when the bot is not saved, "Move back" when it is. Hidden without a control key.
struct SaveForLaterButton: View {
    @ObservedObject var model: FleetModel
    let bot: Bot
    var compact = true

    var body: some View {
        if model.canSave {
            let saved = bot.savedAt != nil
            Button {
                model.setSaved(bot, saved: !saved)
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: saved ? "arrow.uturn.backward" : "bookmark")
                    Text(saved ? "Move back" : "Later")
                }
                .lineLimit(1).fixedSize()
            }
            .buttonStyle(SecondaryButtonStyle(compact: compact))
            .help(saved ? "Move \(bot.name) back out of Save for later" : "Save \(bot.name) for later")
        }
    }
}

/// One saved bot: symbol, name, step, account, when it was saved, and Move back.
struct SavedRow: View {
    @ObservedObject var model: FleetModel
    let row: BotRow
    let now: Double
    var narrow = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "bookmark.fill").font(.system(size: 12)).foregroundStyle(Theme.fg(.violet))
            BotSymbol(bot: row.bot)
            Text(row.bot.name).font(Theme.F.bodyBold).foregroundStyle(Theme.text).lineLimit(1).layoutPriority(1)
            if !narrow {
                Text(row.step).font(Theme.F.body).foregroundStyle(Theme.text2).lineLimit(1)
            }
            Spacer(minLength: 8)
            AccountTag(account: row.account)
            Pill(text: row.bot.savedAt.map { "Saved \(Fmt.clockOrDate($0, now: now))" } ?? "Saved", tone: .violet)
            SaveForLaterButton(model: model, bot: row.bot)
        }
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .card(fill: Theme.tint(.violet).opacity(0.35), dashed: true)
    }
}

/// The Later tab: every bot in Save for later, most recently saved first.
struct LaterView: View {
    @ObservedObject var model: FleetModel
    let d: FleetDerived
    @Environment(\.widthClass) private var width

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Saved for later · \(d.saved.count)")
                if d.saved.isEmpty {
                    Text("Nothing saved for later.").font(Theme.F.body).foregroundStyle(Theme.text3)
                        .padding(.vertical, 6)
                }
                ForEach(d.saved, id: \.key) { row in
                    SavedRow(model: model, row: row, now: d.now, narrow: width == .narrow)
                }
                if !model.canSave {
                    Text("Add the control key in Settings to save bots or move them back.")
                        .font(Theme.F.small).foregroundStyle(Theme.text3).padding(.top, 4)
                }
            }
            .frame(maxWidth: 980, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(width == .narrow ? 14 : 20)
        }
    }
}

/// Dark pill at the bottom of the window: "Saved for later · Undo", or why a change failed.
struct SaveToastView: View {
    @ObservedObject var model: FleetModel

    var body: some View {
        if let toast = model.toast {
            HStack(spacing: 10) {
                Image(systemName: toast.isError ? "exclamationmark.triangle.fill" : "bookmark.fill")
                    .foregroundStyle(toast.isError ? Theme.fill(.red) : Color(hex: 0xC4B5FD))
                Text(toast.text).font(Theme.F.bodyBold).foregroundStyle(Theme.barText).lineLimit(2)
                if toast.undo != nil {
                    Text("·").foregroundStyle(Theme.barText2)
                    Button("Undo") { model.undo(toast) }
                        .buttonStyle(PlainRowButtonStyle())
                        .font(Theme.F.bodyBold)
                        .foregroundStyle(Color(hex: 0x93C5FD))
                        .keyboardShortcut("z", modifiers: .command)
                }
                Button { model.toast = nil } label: {
                    Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.barText2)
                }
                .buttonStyle(PlainRowButtonStyle())
                .accessibilityLabel("Dismiss")
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(Capsule().fill(Theme.bar))
            .overlay(Capsule().strokeBorder(Theme.barLine))
            .shadow(color: .black.opacity(0.18), radius: 10, y: 4)
            .padding(.horizontal, 16).padding(.bottom, 18)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}
