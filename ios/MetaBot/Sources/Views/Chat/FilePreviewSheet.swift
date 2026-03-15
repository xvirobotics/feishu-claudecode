import PDFKit
import QuickLook
import SwiftUI

/// Full-screen file preview sheet
struct FilePreviewSheet: View {
    let file: FileAttachment
    let serverURL: String

    @Environment(\.dismiss) private var dismiss
    @State private var imageData: Data?
    @State private var isLoading = true
    @State private var error: String?

    private var fullURL: URL? {
        URL(string: "\(serverURL)\(file.url)")
    }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("Loading...")
                } else if let error {
                    ContentUnavailableView {
                        Label("Error", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    }
                } else {
                    previewContent
                }
            }
            .navigationTitle(file.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if let url = fullURL {
                        ShareLink(item: url) {
                            Image(systemName: "square.and.arrow.up")
                        }
                    }
                }
            }
        }
        .task { await loadFile() }
    }

    @ViewBuilder
    private var previewContent: some View {
        switch file.category {
        case .image:
            imagePreview
        case .video:
            // Use system link to open video
            if let url = fullURL {
                VStack(spacing: 16) {
                    Image(systemName: "play.circle.fill")
                        .font(.system(size: 64))
                        .foregroundStyle(.secondary)
                    Link("Open Video", destination: url)
                        .font(.headline)
                }
            }
        case .audio:
            if let url = fullURL {
                VStack(spacing: 16) {
                    Image(systemName: "waveform.circle.fill")
                        .font(.system(size: 64))
                        .foregroundStyle(.secondary)
                    Link("Open Audio", destination: url)
                        .font(.headline)
                }
            }
        case .other:
            if file.fileExtension == "pdf", let data = imageData {
                PDFPreviewView(data: data)
            } else {
                // Text / code preview
                if let data = imageData, let text = String(data: data, encoding: .utf8) {
                    ScrollView {
                        Text(text)
                            .font(.system(size: 13, design: .monospaced))
                            .padding()
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else if let url = fullURL {
                    VStack(spacing: 16) {
                        Image(systemName: "doc.fill")
                            .font(.system(size: 64))
                            .foregroundStyle(.secondary)
                        Text(file.name)
                            .font(.headline)
                        Text(file.formattedSize)
                            .foregroundStyle(.secondary)
                        Link("Download", destination: url)
                            .buttonStyle(.borderedProminent)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var imagePreview: some View {
        if let data = imageData {
            #if canImport(UIKit)
            if let uiImage = UIImage(data: data) {
                ZoomableImageView(image: uiImage)
            }
            #endif
        }
    }

    private func loadFile() async {
        guard let url = fullURL else {
            error = "Invalid file URL"
            isLoading = false
            return
        }

        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            await MainActor.run {
                imageData = data
                isLoading = false
            }
        } catch {
            await MainActor.run {
                self.error = error.localizedDescription
                isLoading = false
            }
        }
    }
}

// MARK: - Zoomable Image

struct ZoomableImageView: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> UIScrollView {
        let scrollView = UIScrollView()
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 5
        scrollView.delegate = context.coordinator
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false

        let imageView = UIImageView(image: image)
        imageView.contentMode = .scaleAspectFit
        imageView.tag = 100
        scrollView.addSubview(imageView)

        imageView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            imageView.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            imageView.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            imageView.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            imageView.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor),
            imageView.heightAnchor.constraint(equalTo: scrollView.frameLayoutGuide.heightAnchor),
        ])

        return scrollView
    }

    func updateUIView(_ uiView: UIScrollView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    class Coordinator: NSObject, UIScrollViewDelegate {
        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            scrollView.viewWithTag(100)
        }
    }
}

// MARK: - PDF Preview

struct PDFPreviewView: UIViewRepresentable {
    let data: Data

    func makeUIView(context: Context) -> PDFView {
        let pdfView = PDFView()
        pdfView.autoScales = true
        pdfView.document = PDFDocument(data: data)
        return pdfView
    }

    func updateUIView(_ uiView: PDFView, context: Context) {}
}
