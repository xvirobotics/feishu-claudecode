import SwiftUI
import MarkdownUI

struct MemoryView: View {
    @Environment(AppState.self) private var appState

    @State private var folders: [MemoryFolder] = []
    @State private var documents: [MemoryDocument] = []
    @State private var selectedDoc: MemoryDocument?
    @State private var docContent: String?
    @State private var searchQuery = ""
    @State private var isLoading = false
    @State private var currentFolderId: String?

    var body: some View {
        NavigationStack {
            Group {
                if let doc = selectedDoc, let content = docContent {
                    // Document view
                    ScrollView {
                        Markdown(content)
                            .markdownTheme(.metabot)
                            .padding()
                    }
                    .navigationTitle(doc.title)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Back") {
                                selectedDoc = nil
                                docContent = nil
                            }
                        }
                    }
                } else {
                    // List view
                    List {
                        if !folders.isEmpty {
                            Section("Folders") {
                                ForEach(folders) { folder in
                                    Button {
                                        currentFolderId = folder.id
                                        Task { await loadFolder(folder.id) }
                                    } label: {
                                        Label(folder.name, systemImage: "folder")
                                    }
                                }
                            }
                        }

                        if !documents.isEmpty {
                            Section("Documents") {
                                ForEach(documents) { doc in
                                    Button {
                                        Task { await loadDocument(doc) }
                                    } label: {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(doc.title)
                                                .font(.subheadline.bold())
                                                .foregroundStyle(.primary)
                                            if !doc.tags.isEmpty {
                                                Text(doc.tags.joined(separator: ", "))
                                                    .font(.caption)
                                                    .foregroundStyle(.secondary)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    .searchable(text: $searchQuery, prompt: "Search documents")
                    .onSubmit(of: .search) {
                        Task { await search() }
                    }
                    .navigationTitle("Memory")
                    .toolbar {
                        if currentFolderId != nil {
                            ToolbarItem(placement: .topBarLeading) {
                                Button {
                                    currentFolderId = nil
                                    Task { await loadRoot() }
                                } label: {
                                    Label("Root", systemImage: "arrow.left")
                                }
                            }
                        }
                    }
                    .overlay {
                        if isLoading {
                            ProgressView()
                        } else if folders.isEmpty && documents.isEmpty {
                            ContentUnavailableView {
                                Label("No Documents", systemImage: "doc.text")
                            } description: {
                                Text("MetaMemory documents will appear here")
                            }
                        }
                    }
                }
            }
            .task { await loadRoot() }
        }
    }

    // MARK: - API

    private var baseURL: String { "\(appState.serverURL)/memory/api" }

    private func loadRoot() async {
        isLoading = true
        defer { isLoading = false }

        await withTaskGroup(of: Void.self) { group in
            group.addTask { await loadFolders() }
            group.addTask { await loadDocuments(folderId: nil) }
        }
    }

    private func loadFolder(_ id: String) async {
        isLoading = true
        defer { isLoading = false }
        await loadDocuments(folderId: id)
    }

    private func loadFolders() async {
        guard let url = URL(string: "\(baseURL)/folders") else { return }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let result = try JSONDecoder().decode([MemoryFolder].self, from: data)
            await MainActor.run { folders = result }
        } catch {
            print("Failed to load folders: \(error)")
        }
    }

    private func loadDocuments(folderId: String?) async {
        var urlString = "\(baseURL)/documents"
        if let folderId { urlString += "?folder_id=\(folderId)" }
        guard let url = URL(string: urlString) else { return }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let result = try JSONDecoder().decode([MemoryDocument].self, from: data)
            await MainActor.run { documents = result }
        } catch {
            print("Failed to load documents: \(error)")
        }
    }

    private func loadDocument(_ doc: MemoryDocument) async {
        guard let url = URL(string: "\(baseURL)/documents/\(doc.id)") else { return }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let full = try JSONDecoder().decode(MemoryDocumentFull.self, from: data)
            await MainActor.run {
                selectedDoc = doc
                docContent = full.content
            }
        } catch {
            print("Failed to load document: \(error)")
        }
    }

    private func search() async {
        guard !searchQuery.isEmpty else {
            await loadRoot()
            return
        }
        guard let encoded = searchQuery.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(baseURL)/search?q=\(encoded)") else { return }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let result = try JSONDecoder().decode([MemoryDocument].self, from: data)
            await MainActor.run {
                documents = result
                folders = []
            }
        } catch {
            print("Search failed: \(error)")
        }
    }
}

// MARK: - Models

struct MemoryFolder: Codable, Identifiable {
    let id: String
    let name: String
}

struct MemoryDocument: Codable, Identifiable {
    let id: String
    let title: String
    let tags: [String]

    enum CodingKeys: String, CodingKey {
        case id, title, tags
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        tags = (try? c.decode([String].self, forKey: .tags)) ?? []
    }
}

struct MemoryDocumentFull: Codable {
    let id: String
    let title: String
    let content: String
}
