import SwiftUI

/// Deterministic gradient avatar based on name hash using NEXUS palette colors
struct GradientAvatar: View {
    let name: String
    let size: CGFloat

    /// NEXUS palette hues for avatar variety
    private static let paletteColors: [(Color, Color)] = [
        (NexusColors.accent, NexusColors.accentHover),
        (NexusColors.green, NexusColors.accent),
        (NexusColors.blue, NexusColors.purple),
        (NexusColors.purple, NexusColors.accent),
        (NexusColors.amber, NexusColors.red),
        (NexusColors.blue, NexusColors.green),
    ]

    private var colors: (Color, Color) {
        let hash = Self.stableHash(name)
        let idx = hash % Self.paletteColors.count
        return Self.paletteColors[idx]
    }

    /// Deterministic hash stable across app launches (unlike hashValue which is randomized)
    private static func stableHash(_ string: String) -> Int {
        var hash: UInt64 = 5381
        for char in string.utf8 {
            hash = hash &* 33 &+ UInt64(char)
        }
        return Int(hash % UInt64(Int.max))
    }

    private var initial: String {
        String(name.prefix(1)).uppercased()
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        colors: [colors.0, colors.1],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
            Text(initial)
                .font(.system(size: size * 0.38, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
    }
}
