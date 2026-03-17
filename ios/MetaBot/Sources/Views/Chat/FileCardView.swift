import SwiftUI

struct FileCardView: View {
    let file: FileAttachment
    let serverURL: String
    var compact: Bool = false

    var body: some View {
        if file.category == .image {
            imageCard
        } else {
            genericCard
        }
    }

    /// Inline image thumbnail for image files
    private var imageCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let url = URL(string: "\(serverURL)\(file.url)") {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(maxWidth: 260, maxHeight: 200)
                            .clipShape(RoundedRectangle(cornerRadius: NexusRadius.md))
                    case .failure:
                        genericCard
                    default:
                        RoundedRectangle(cornerRadius: NexusRadius.md)
                            .fill(NexusColors.surface2)
                            .frame(width: 160, height: 100)
                            .overlay {
                                NexusThinkingDots()
                            }
                    }
                }
            }
        }
    }

    /// Generic file card with extension badge
    private var genericCard: some View {
        HStack(spacing: 10) {
            // Extension badge
            Text(file.fileExtension.uppercased().prefix(4))
                .font(NexusTypography.jetBrainsMono(size: 9))
                .foregroundStyle(NexusColors.accentText)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(NexusColors.accentSofter)
                .clipShape(RoundedRectangle(cornerRadius: NexusRadius.sm))

            VStack(alignment: .leading, spacing: 2) {
                Text(file.name)
                    .font(NexusTypography.caption)
                    .foregroundStyle(NexusColors.text0)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(file.formattedSize)
                    .font(NexusTypography.label)
                    .foregroundStyle(NexusColors.text2)
            }

            Spacer()

            if let url = URL(string: "\(serverURL)\(file.url)") {
                Link(destination: url) {
                    Image(systemName: "arrow.down.circle")
                        .font(.body)
                        .foregroundStyle(NexusColors.text2)
                }
            }
        }
        .padding(NexusSpacing.md)
        .background(NexusColors.surface2)
        .clipShape(RoundedRectangle(cornerRadius: NexusRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: NexusRadius.md)
                .stroke(NexusColors.glassBorder, lineWidth: 1)
        )
    }
}
