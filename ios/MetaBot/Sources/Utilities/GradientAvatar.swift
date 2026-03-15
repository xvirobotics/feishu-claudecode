import SwiftUI

/// Deterministic gradient avatar based on name hash (matches Web UI)
struct GradientAvatar: View {
    let name: String
    let size: CGFloat

    private var colors: [Color] {
        let hash = Self.stableHash(name)
        let hue1 = Double(hash % 360) / 360.0
        let hue2 = (hue1 + 0.3).truncatingRemainder(dividingBy: 1.0)
        return [
            Color(hue: hue1, saturation: 0.6, brightness: 0.8),
            Color(hue: hue2, saturation: 0.7, brightness: 0.7),
        ]
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
                        colors: colors,
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
            Text(initial)
                .font(.system(size: size * 0.4, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
    }
}
