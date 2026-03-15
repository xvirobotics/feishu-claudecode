import PhotosUI
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// Pending file attachment before sending
struct PendingFile: Identifiable {
    let id = UUID()
    let name: String
    let data: Data
    let mimeType: String
    let thumbnail: Image?

    var size: Int { data.count }

    var formattedSize: String {
        if size < 1024 { return "\(size) B" }
        if size < 1024 * 1024 { return String(format: "%.1f KB", Double(size) / 1024) }
        return String(format: "%.1f MB", Double(size) / (1024 * 1024))
    }

    var fileExtension: String {
        let ext = (name as NSString).pathExtension.lowercased()
        return ext.isEmpty ? "?" : ext
    }
}

/// File attachment bar shown above the input when files are selected
struct PendingFilesBar: View {
    let files: [PendingFile]
    let onRemove: (PendingFile) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(files) { file in
                    pendingFileChip(file)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
    }

    private func pendingFileChip(_ file: PendingFile) -> some View {
        HStack(spacing: 6) {
            if let thumb = file.thumbnail {
                thumb
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 28, height: 28)
                    .clipShape(RoundedRectangle(cornerRadius: 4))
            } else {
                ZStack {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.accentColor.opacity(0.15))
                        .frame(width: 28, height: 28)
                    Text(file.fileExtension.uppercased().prefix(3))
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .foregroundStyle(Color.accentColor)
                }
            }

            VStack(alignment: .leading, spacing: 1) {
                Text(file.name)
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(file.formattedSize)
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }

            Button {
                onRemove(file)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

/// Document picker wrapper
struct DocumentPickerView: UIViewControllerRepresentable {
    let onPick: ([URL]) -> Void

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [
            .item, // all file types
        ], asCopy: true)
        picker.allowsMultipleSelection = true
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIDocumentPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onPick: onPick)
    }

    class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onPick: ([URL]) -> Void
        init(onPick: @escaping ([URL]) -> Void) { self.onPick = onPick }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            onPick(urls)
        }
    }
}

/// Helper to determine MIME type from URL
func mimeType(for url: URL) -> String {
    if let utType = UTType(filenameExtension: url.pathExtension) {
        return utType.preferredMIMEType ?? "application/octet-stream"
    }
    return "application/octet-stream"
}

/// Helper to determine MIME type from extension string
func mimeType(forExtension ext: String) -> String {
    if let utType = UTType(filenameExtension: ext) {
        return utType.preferredMIMEType ?? "application/octet-stream"
    }
    return "application/octet-stream"
}
