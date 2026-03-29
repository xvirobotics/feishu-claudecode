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

    // Mic pulse animation
    @State private var micPulse = false

    // Phone call
    @State private var showPhoneCall = false
    @State private var showRtcCall = false

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingFiles.isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            // Upload progress
            if isUploading {
                HStack(spacing: 6) {
                    NexusThinkingDots()
                        .frame(width: 24, height: 14)
                    Text("Uploading...")
                        .font(NexusTypography.caption)
                        .foregroundStyle(NexusColors.text2)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 6)
            }

            // Pending files bar
            if !pendingFiles.isEmpty {
                PendingFilesBar(files: pendingFiles) { file in
                    pendingFiles.removeAll { $0.id == file.id }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 6)
            }

            // Recording indicator
            if voiceService.isRecording {
                recordingIndicator
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            // Input wrapper
            HStack(alignment: .center, spacing: 8) {
                // Left buttons
                HStack(spacing: 4) {
                    // Attach button
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
                        Image(systemName: "paperclip")
                            .font(.system(size: 16))
                            .foregroundStyle(NexusColors.text2)
                            .frame(width: 36, height: 36)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Attach")

                    // Mic button
                    if !appState.isRunning {
                        Button {
                            toggleVoiceInput()
                        } label: {
                            ZStack {
                                if voiceService.isRecording {
                                    Circle()
                                        .stroke(NexusColors.red.opacity(0.4), lineWidth: 2)
                                        .frame(width: 40, height: 40)
                                        .scaleEffect(micPulse ? 1.3 : 1.0)
                                        .opacity(micPulse ? 0.0 : 0.8)
                                        .animation(
                                            .easeOut(duration: 1.2).repeatForever(autoreverses: false),
                                            value: micPulse
                                        )
                                }

                                Image(systemName: "mic.fill")
                                    .font(.system(size: 16))
                                    .foregroundStyle(voiceService.isRecording ? NexusColors.red : NexusColors.text2)
                                    .frame(width: 36, height: 36)
                            }
                        }
                        .accessibilityLabel(voiceService.isRecording ? "Stop recording" : "Start voice input")
                        .onChange(of: voiceService.isRecording) { _, recording in
                            micPulse = recording
                        }
                    }
                }

                // TextEditor
                TextField("Ask anything...", text: $text, axis: .vertical)
                    .lineLimit(1...8)
                    .font(NexusTypography.body)
                    .foregroundStyle(NexusColors.text0)
                    .frame(minHeight: 24)
                    .focused($isFocused)
                    .submitLabel(.send)
                    .onSubmit { send() }

                // Right buttons
                HStack(spacing: 4) {
                    // Phone call button
                    Button {
                        if appState.rtcAvailable {
                            showRtcCall = true
                        } else {
                            showPhoneCall = true
                        }
                    } label: {
                        Image(systemName: "phone.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(NexusColors.text2)
                            .frame(width: 38, height: 38)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Voice call")

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
                                .background(NexusColors.red)
                                .clipShape(RoundedRectangle(cornerRadius: NexusRadius.sm))
                        }
                        .accessibilityLabel("Stop")
                        .buttonStyle(.plain)
                    } else {
                        Button {
                            send()
                        } label: {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 36, height: 36)
                                .background(NexusColors.accent)
                                .clipShape(RoundedRectangle(cornerRadius: NexusRadius.sm))
                                .opacity(canSend ? 1.0 : 0.15)
                        }
                        .accessibilityLabel("Send message")
                        .buttonStyle(SendButtonStyle())
                        .disabled(!canSend || !appState.isConnected)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(NexusColors.surface1)
            .clipShape(RoundedRectangle(cornerRadius: NexusRadius.lg))
            .overlay(
                RoundedRectangle(cornerRadius: NexusRadius.lg)
                    .stroke(
                        isFocused ? NexusColors.accent.opacity(0.3) : NexusColors.glassBorder,
                        lineWidth: 1
                    )
            )
            .shadow(
                color: isFocused ? NexusColors.accent.opacity(0.1) : .clear,
                radius: 4,
                x: 0,
                y: 0
            )
            .animation(NexusMotion.base, value: isFocused)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 8)
        }
        .animation(NexusMotion.base, value: voiceService.isRecording)
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
        .fullScreenCover(isPresented: $showPhoneCall) {
            if let botName = appState.activeBotName {
                let chatId = appState.activeSessionId ?? "call_\(UUID().uuidString.prefix(8))"
                PhoneCallView(botName: botName, chatId: chatId)
                    .environment(appState)
            }
        }
        .fullScreenCover(isPresented: $showRtcCall) {
            if let botName = appState.activeBotName {
                let chatId = appState.activeSessionId ?? "call_\(UUID().uuidString.prefix(8))"
                RtcCallView(botName: botName, chatId: chatId, incoming: nil)
                    .environment(appState)
            }
        }
    }

    // MARK: - Recording Indicator

    private var recordingIndicator: some View {
        HStack(spacing: 10) {
            // Waveform bars
            HStack(spacing: 3) {
                ForEach(0..<5, id: \.self) { i in
                    WaveformBar(index: i)
                }
            }
            .frame(width: 24, height: 18)

            // Streaming ASR text
            if !voiceService.transcribedText.isEmpty {
                Text(voiceService.transcribedText)
                    .font(NexusTypography.body)
                    .foregroundStyle(NexusColors.text0)
                    .lineLimit(2)
            } else {
                Text("Listening...")
                    .font(NexusTypography.body)
                    .foregroundStyle(NexusColors.text2)
            }

            Spacer()

            Text("Tap mic to stop")
                .font(NexusTypography.spaceGrotesk(size: 11))
                .foregroundStyle(NexusColors.text2)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(NexusColors.surface1)
        .clipShape(RoundedRectangle(cornerRadius: NexusRadius.xl))
        .overlay(
            RoundedRectangle(cornerRadius: NexusRadius.xl)
                .stroke(NexusColors.accent.opacity(0.2), lineWidth: 1)
        )
        .shadow(color: NexusColors.accent.opacity(0.08), radius: 12, x: 0, y: 4)
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

// MARK: - Send Button Style (scale on press)

private struct SendButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.95 : 1.0)
            .animation(NexusMotion.fast, value: configuration.isPressed)
    }
}

// MARK: - Waveform Bar

private struct WaveformBar: View {
    let index: Int
    @State private var height: CGFloat = 4

    var body: some View {
        RoundedRectangle(cornerRadius: 1)
            .fill(NexusColors.accent)
            .frame(width: 3, height: height)
            .onAppear {
                withAnimation(
                    .easeInOut(duration: Double.random(in: 0.3...0.6))
                        .repeatForever(autoreverses: true)
                        .delay(Double(index) * 0.1)
                ) {
                    height = CGFloat.random(in: 8...18)
                }
            }
    }
}
