import SwiftUI

struct EmptyStateView: View {
    let onHintTap: (String) -> Void

    private let hints = [
        "Explain how this project works",
        "Find and fix bugs in my code",
        "Write tests for the main module",
        "Refactor this function for clarity",
    ]

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            // Logo
            ZStack {
                Circle()
                    .fill(Color.accentColor.opacity(0.1))
                    .frame(width: 72, height: 72)
                Text("M")
                    .font(.system(size: 32, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.accentColor)
            }

            VStack(spacing: 6) {
                Text("MetaBot")
                    .font(.title2.bold())
                Text("Ask anything to get started")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            // Hint buttons
            VStack(spacing: 8) {
                ForEach(hints, id: \.self) { hint in
                    Button {
                        onHintTap(hint)
                    } label: {
                        Text(hint)
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            .background(.quaternary)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 24)

            Spacer()
            Spacer()
        }
    }
}
