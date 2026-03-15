import PhotosUI
import SwiftUI

struct InputBar: View {
    @Environment(AppState.self) private var appState
    @State private var text = ""
    @FocusState private var isFocused: Bool

    // File picker
    @State private var pendingFiles: [PendingFile] = []
    @State private var showPhotosPicker = false
    @State private var showDocumentPicker = false
    @State private var showAttachMenu = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var isUploading = false

    // Voice input
    @State private var voiceService = VoiceService()
    @State private var showVoiceHint = false

    var body: some View {
        VStack(spacing: 0) {
            Divider()

            // Pending files bar
            if !pendingFiles.isEmpty {
                PendingFilesBar(files: pendingFiles) { file in
                    pendingFiles.removeAll { $0.id == file.id }
                }
            }

            // Upload progress
            if isUploading {
                HStack(spacing: 6) {
                    ProgressView()
                        .scaleEffect(0.7)
                    Text("Uploading...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 4)
            }

            HStack(alignment: .bottom, spacing: 6) {
                // Attachment button
                Menu {
                    Button {
                        showPhotosPicker = true
                    } label: {
                        Label("Photos", systemImage: "photo.on.rectangle")
                    }
                    Button {
                        showDocumentPicker = true
                    } label: {
                        Label("Files", systemImage: "doc")
                    }
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 24))
                        .foregroundStyle(.secondary)
                        .frame(width: 36, height: 36)
                }

                // Text field
                TextField("Ask anything...", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .font(.body)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.quaternary)
                    .clipShape(RoundedRectangle(cornerRadius: 20))
                    .focused($isFocused)
                    .submitLabel(.send)
                    .onSubmit { send() }

                // Mic button (voice input → text)
                if text.isEmpty && pendingFiles.isEmpty && !appState.isRunning {
                    Button {
                        toggleVoiceInput()
                    } label: {
                        Image(systemName: voiceService.isRecording ? "mic.fill" : "mic")
                            .font(.system(size: 16))
                            .foregroundStyle(voiceService.isRecording ? Color.accentColor : .secondary)
                            .frame(width: 36, height: 36)
                            .background(voiceService.isRecording ? Color.accentColor.opacity(0.15) : .clear)
                            .clipShape(Circle())
                    }
                }

                // Send / Stop button
                if appState.isRunning {
                    Button {
                        Haptics.notification(.warning)
                        appState.stopTask()
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(.red)
                            .clipShape(Circle())
                    }
                } else if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingFiles.isEmpty {
                    Button {
                        send()
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(Color.accentColor)
                            .clipShape(Circle())
                    }
                    .disabled(!appState.isConnected)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .padding(.bottom, 4)
        }
        .background(.bar)
        .photosPicker(isPresented: $showPhotosPicker, selection: $selectedPhotos, matching: .any(of: [.images, .screenshots, .videos]))
        .sheet(isPresented: $showDocumentPicker) {
            DocumentPickerView { urls in
                loadDocuments(urls)
            }
        }
        .onChange(of: selectedPhotos) { _, items in
            loadPhotos(items)
            selectedPhotos = []
        }
        .alert("Voice Input", isPresented: $showVoiceHint) {
            Button("OK") {}
        } message: {
            Text("Tap the mic button to start speaking. Your speech will be converted to text.")
        }
    }

    // MARK: - Send

    private func send() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

        // Stop any recording
        if voiceService.isRecording {
            _ = voiceService.stopRecording()
            let transcribed = voiceService.transcribedText
            if !transcribed.isEmpty && trimmed.isEmpty {
                text = transcribed
            }
            voiceService.cleanupRecording()
        }

        let finalText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !finalText.isEmpty || !pendingFiles.isEmpty else { return }

        Haptics.impact(.light)

        if !pendingFiles.isEmpty {
            uploadAndSend(text: finalText)
        } else {
            appState.sendMessage(text: finalText)
            text = ""
        }
    }

    // MARK: - Voice Input

    private func toggleVoiceInput() {
        if voiceService.isRecording {
            _ = voiceService.stopRecording()
            let transcribed = voiceService.transcribedText
            if !transcribed.isEmpty {
                text = transcribed
            }
            voiceService.cleanupRecording()
        } else {
            Task {
                await voiceService.requestPermissions()
                guard voiceService.permissionGranted else {
                    showVoiceHint = true
                    return
                }
                do {
                    try voiceService.startRecording()
                } catch {
                    print("[Voice] Start error: \(error)")
                }
            }
        }
    }

    // MARK: - File Loading

    private func loadPhotos(_ items: [PhotosPickerItem]) {
        Task {
            for item in items {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    let filename = "photo_\(UUID().uuidString.prefix(8)).jpg"
                    var thumbnail: Image? = nil
                    #if canImport(UIKit)
                    if let uiImage = UIImage(data: data) {
                        thumbnail = Image(uiImage: uiImage)
                    }
                    #endif
                    let file = PendingFile(
                        name: filename,
                        data: data,
                        mimeType: "image/jpeg",
                        thumbnail: thumbnail
                    )
                    await MainActor.run { pendingFiles.append(file) }
                }
            }
        }
    }

    private func loadDocuments(_ urls: [URL]) {
        for url in urls {
            guard url.startAccessingSecurityScopedResource() else { continue }
            defer { url.stopAccessingSecurityScopedResource() }

            if let data = try? Data(contentsOf: url) {
                let file = PendingFile(
                    name: url.lastPathComponent,
                    data: data,
                    mimeType: mimeType(for: url),
                    thumbnail: nil
                )
                pendingFiles.append(file)
            }
        }
    }

    // MARK: - Upload & Send

    private func uploadAndSend(text: String) {
        guard let token = appState.auth.token else { return }
        let sessionId = appState.activeSessionId ?? appState.createSession()
        isUploading = true

        Task {
            var attachments: [FileAttachment] = []
            let fileService = FileService(serverURL: appState.serverURL, token: token)

            for file in pendingFiles {
                do {
                    let result = try await fileService.upload(
                        data: file.data,
                        filename: file.name,
                        mimeType: file.mimeType,
                        chatId: sessionId
                    )
                    let attachment = FileAttachment(
                        name: file.name,
                        type: file.mimeType,
                        size: file.size,
                        url: result.path,
                        path: result.path
                    )
                    attachments.append(attachment)
                } catch {
                    print("[Upload] Failed: \(error)")
                }
            }

            await MainActor.run {
                isUploading = false
                pendingFiles.removeAll()
                let messageText = text.isEmpty ? "I've uploaded \(attachments.count) file(s)." : text
                appState.sendMessage(text: messageText, attachments: attachments)
                self.text = ""
            }
        }
    }
}
