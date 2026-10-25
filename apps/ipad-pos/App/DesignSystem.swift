import SwiftUI

/// Solid content surfaces; translucent material is reserved for navigation and action chrome.
enum Design {
    static let accent = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.65, green: 0.84, blue: 0.73, alpha: 1) : UIColor(red: 0.086, green: 0.239, blue: 0.204, alpha: 1) })
    static let canvas = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? .systemGroupedBackground : UIColor(red: 0.96, green: 0.96, blue: 0.94, alpha: 1) })
    static let surface = Color(uiColor: .secondarySystemGroupedBackground)
    static let mutedSurface = Color(uiColor: .tertiarySystemGroupedBackground)
    static let border = Color.primary.opacity(0.10)
    static let ink = Color.primary
}
struct ResutoCard<Content: View>: View {
    var padding: CGFloat = 20
    @ViewBuilder var content: () -> Content
    var body: some View {
        content().padding(padding).frame(maxWidth: .infinity, alignment: .leading)
            .background(Design.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Design.border, lineWidth: 1) }
    }
}
enum StatusTone { case neutral, positive, warning, danger
    var color: Color { switch self { case .neutral: Design.accent; case .positive: .green; case .warning: .orange; case .danger: .red } }
}
struct StatusBadge: View {
    let text: String
    var symbol: String = "circle.fill"
    var tone: StatusTone = .neutral
    var body: some View {
        Label(text, systemImage: symbol).font(.subheadline.weight(.semibold))
            .foregroundStyle(.primary).padding(.horizontal, 12).padding(.vertical, 8)
            .background(tone.color.opacity(0.12), in: Capsule()).accessibilityElement(children: .combine)
    }
}
struct PrimaryActionStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    func makeBody(configuration: ButtonStyleConfiguration) -> some View {
        configuration.label.font(.headline).frame(maxWidth: .infinity, minHeight: 52)
            .padding(.horizontal, 16).foregroundStyle(enabled ? Color(uiColor: .systemBackground) : .secondary)
            .background(enabled ? Design.accent : Color.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
            .opacity(configuration.isPressed ? 0.82 : 1)
            .animation(reducedMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
struct ActionChrome: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var opaque
    func body(content: Content) -> some View {
        content.background { if opaque { Design.surface } else { Rectangle().fill(.regularMaterial) } }
            .overlay(alignment: .top) { Rectangle().fill(Design.border).frame(height: 1) }
    }
}
