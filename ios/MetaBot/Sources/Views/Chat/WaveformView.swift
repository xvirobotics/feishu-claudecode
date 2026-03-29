import SwiftUI

/// Animated waveform visualization — mirrors web VoiceView.tsx's 24-bar waveform.
/// Uses TimelineView for smooth 30fps updates aligned to display vsync.
struct WaveformView: View {
    var audioLevel: Float  // 0.0 – 1.0
    var isActive: Bool
    var barCount: Int = 24
    var barWidth: CGFloat = 3
    var barSpacing: CGFloat = 3
    var maxBarHeight: CGFloat = 48
    var minBarHeight: CGFloat = 4
    var color: Color = NexusColors.accent

    // Sine-wave distribution for organic variation across bars
    private var sineMultipliers: [Double] {
        (0..<barCount).map { i in
            let t = Double(i) / Double(barCount - 1)
            return 0.4 + 0.6 * sin(.pi * t)
        }
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            let phase = timeline.date.timeIntervalSinceReferenceDate
            HStack(spacing: barSpacing) {
                ForEach(0..<barCount, id: \.self) { i in
                    barView(index: i, phase: phase)
                }
            }
        }
        .frame(height: maxBarHeight)
    }

    private func barView(index: Int, phase: Double) -> some View {
        let multiplier = sineMultipliers[index]
        let swayFreq = 1.2 + Double(index % 5) * 0.3
        let swayAmp = 0.15
        let sway = sin(phase * swayFreq + Double(index)) * swayAmp

        let targetHeight: CGFloat
        if isActive {
            let levelContrib = Double(audioLevel) * multiplier
            let swayContrib = max(0, sway)
            targetHeight = minBarHeight + CGFloat(levelContrib + swayContrib) * (maxBarHeight - minBarHeight)
        } else {
            targetHeight = minBarHeight
        }

        let clampedHeight = min(max(targetHeight, minBarHeight), maxBarHeight)
        let opacity = isActive ? (0.5 + Double(audioLevel) * 0.5) : 0.3

        return RoundedRectangle(cornerRadius: barWidth / 2)
            .fill(color.opacity(opacity))
            .frame(width: barWidth, height: clampedHeight)
            .animation(NexusMotion.slow, value: isActive)
    }
}

#Preview {
    ZStack {
        Color.black
        WaveformView(audioLevel: 0.6, isActive: true)
            .padding(.horizontal, 40)
    }
}
