import SwiftUI

// MARK: - NEXUS Design System
// Mirrors the web frontend's theme.css NEXUS design system

// MARK: - Colors

enum NexusColors {
    // Backgrounds
    static let void = Color("NexusVoid")
    static let surface0 = Color("NexusSurface0")
    static let surface1 = Color("NexusSurface1")
    static let surface2 = Color("NexusSurface2")
    static let surface3 = Color("NexusSurface3")

    // Accent
    static let accent = Color("NexusAccent")
    static let accentSoft = Color("NexusAccentSoft")
    static let accentHover = Color("NexusAccentHover")

    // Text
    static let text0 = Color("NexusText0")
    static let text1 = Color("NexusText1")
    static let text2 = Color("NexusText2")

    // Semantic
    static let green = Color("NexusGreen")
    static let red = Color("NexusRed")
    static let amber = Color("NexusAmber")
    static let blue = Color("NexusBlue")
    static let purple = Color("NexusPurple")

    // Surfaces with opacity
    static let glassBorder = Color.white.opacity(0.06)
    static let glassBorderLight = Color.black.opacity(0.08)

    // Code
    static let codeBg = Color("NexusCodeBg")

    // User bubble gradient
    static let userBubbleStart = Color("NexusAccent")
    static let userBubbleEnd = Color("NexusAccentHover")

    // User bubble uses solid accent (not gradient) to match web exactly
    static let userBubble = Color("NexusAccent")

    // Extended palette
    static let accentText = Color("NexusAccentText")     // bright green for text on dark
    static let accentSofter = Color("NexusAccentSofter") // ultra-soft accent bg
    static let surfaceHover = Color("NexusSurfaceHover") // interactive hover state
    static let text3 = Color("NexusText3")               // disabled/quaternary text

    // Semantic soft backgrounds
    static let redSoft = Color("NexusRedSoft")
    static let greenSoft = Color("NexusGreenSoft")
    static let amberSoft = Color("NexusAmberSoft")
    static let blueSoft = Color("NexusBlueSoft")
}

// MARK: - Font Scale

enum NexusFontScale {
    static var current: Double = 1.0  // set by AppState

    static func scaled(_ size: CGFloat) -> CGFloat {
        return size * CGFloat(current)
    }
}

// MARK: - Typography

enum NexusTypography {
    // Space Grotesk or system fallback
    static func spaceGrotesk(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        if UIFont.familyNames.contains("Space Grotesk") {
            return .custom("SpaceGrotesk-\(weightName(weight))", size: size)
        }
        return .system(size: size, weight: weight, design: .rounded)
    }

    // JetBrains Mono or system fallback
    static func jetBrainsMono(size: CGFloat) -> Font {
        if UIFont.familyNames.contains("JetBrains Mono") {
            return .custom("JetBrainsMono-Regular", size: size)
        }
        return .system(size: size, design: .monospaced)
    }

    private static func weightName(_ weight: Font.Weight) -> String {
        switch weight {
        case .medium: return "Medium"
        case .semibold, .bold: return "Bold"
        default: return "Regular"
        }
    }

    // Semantic text styles (scaled by NexusFontScale)
    static var label: Font { jetBrainsMono(size: NexusFontScale.scaled(11)) }
    static var caption: Font { spaceGrotesk(size: NexusFontScale.scaled(12)) }
    static var body: Font { spaceGrotesk(size: NexusFontScale.scaled(15)) }
    static var heading: Font { spaceGrotesk(size: NexusFontScale.scaled(17), weight: .semibold) }
    static var title: Font { spaceGrotesk(size: NexusFontScale.scaled(22), weight: .semibold) }
    static var codeBody: Font { jetBrainsMono(size: NexusFontScale.scaled(13)) }
}

// MARK: - Spacing

enum NexusSpacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
}

// MARK: - Radius

enum NexusRadius {
    static let sm: CGFloat = 6
    static let md: CGFloat = 10
    static let lg: CGFloat = 14
    static let xl: CGFloat = 18
    static let full: CGFloat = 999
}

// MARK: - Motion

enum NexusMotion {
    static let fast = Animation.easeOut(duration: 0.10)
    static let base = Animation.easeOut(duration: 0.18)
    static let slow = Animation.easeOut(duration: 0.30)
    static let enter = Animation.spring(response: 0.4, dampingFraction: 0.8)
    static let spring = Animation.spring(response: 0.4, dampingFraction: 0.55)
}

// MARK: - Layout

enum NexusLayout {
    static let maxContentWidth: CGFloat = 740
    static let chatHorizontalPadding: CGFloat = 28
    static let chatTopPadding: CGFloat = 36
    static let chatBottomPadding: CGFloat = 24
    static let inputBarHorizontalPadding: CGFloat = 28
    static let callViewHorizontalPadding: CGFloat = 40
    static let maxHintWidth: CGFloat = 500
}

// MARK: - Shadow ViewModifiers

struct NexusShadowSm: ViewModifier {
    func body(content: Content) -> some View {
        content.shadow(color: .black.opacity(0.3), radius: 4, x: 0, y: 2)
    }
}

struct NexusShadowMd: ViewModifier {
    func body(content: Content) -> some View {
        content.shadow(color: .black.opacity(0.35), radius: 10, x: 0, y: 4)
    }
}

struct NexusShadowAccent: ViewModifier {
    func body(content: Content) -> some View {
        content.shadow(color: NexusColors.accent.opacity(0.20), radius: 12, x: 0, y: 4)
    }
}

struct NexusShadowGlow: ViewModifier {
    func body(content: Content) -> some View {
        content.shadow(color: NexusColors.accent.opacity(0.10), radius: 20, x: 0, y: 0)
    }
}

struct NexusGlassBorder: ViewModifier {
    var radius: CGFloat = NexusRadius.md
    func body(content: Content) -> some View {
        content.overlay {
            RoundedRectangle(cornerRadius: radius)
                .stroke(NexusColors.glassBorder, lineWidth: 1)
        }
    }
}

extension View {
    func nexusShadowSm() -> some View { modifier(NexusShadowSm()) }
    func nexusShadowMd() -> some View { modifier(NexusShadowMd()) }
    func nexusShadowAccent() -> some View { modifier(NexusShadowAccent()) }
    func nexusShadowGlow() -> some View { modifier(NexusShadowGlow()) }
    func nexusGlassBorder(radius: CGFloat = NexusRadius.md) -> some View { modifier(NexusGlassBorder(radius: radius)) }
}

// MARK: - Pulsing Dot

struct NexusPulsingDot: View {
    var color: Color = NexusColors.accent
    var size: CGFloat = 8
    @State private var scale: CGFloat = 1.0

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .scaleEffect(scale)
            .onAppear {
                withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                    scale = 1.3
                }
            }
    }
}

// MARK: - Thinking Dots Animation

struct NexusThinkingDots: View {
    @State private var phase: Int = 0
    let timer = Timer.publish(every: 0.4, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(NexusColors.accent)
                    .frame(width: 5, height: 5)
                    .scaleEffect(phase == i ? 1.4 : 0.8)
                    .opacity(phase == i ? 1.0 : 0.4)
                    .animation(NexusMotion.base, value: phase)
            }
        }
        .onReceive(timer) { _ in
            phase = (phase + 1) % 3
        }
    }
}
