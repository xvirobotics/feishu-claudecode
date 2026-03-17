import SwiftUI

/// Small copy button for code blocks
struct CopyCodeButton: View {
    let code: String
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = code
            copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                copied = false
            }
        } label: {
            Text(copied ? "Copied" : "Copy")
                .font(NexusTypography.jetBrainsMono(size: 11))
                .foregroundStyle(copied ? NexusColors.green : NexusColors.text2)
        }
        .buttonStyle(.plain)
    }
}
