import SwiftUI
import MarkdownUI

// MARK: - Models

struct MemoryFolder: Codable, Identifiable {
    let id: String
    let name: String
    let parentId: String?

    enum CodingKeys: String, CodingKey {
        case id, name
        case parentId = "parent_id"
    }
}

struct MemoryDocument: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let path: String
    let tags: [String]
    let snippet: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, title, path, tags, snippet
        case updatedAt = "updated_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        path = (try? c.decode(String.self, forKey: .path)) ?? ""
        tags = (try? c.decode([String].self, forKey: .tags)) ?? []
        snippet = try? c.decode(String.self, forKey: .snippet)
        updatedAt = try? c.decode(String.self, forKey: .updatedAt)
    }
}

struct MemoryDocumentFull: Codable {
    let id: String
    let title: String
    let content: String?
    let path: String?
    let tags: [String]?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, title, content, path, tags
        case updatedAt = "updated_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        content = try? c.decode(String.self, forKey: .content)
        path = try? c.decode(String.self, forKey: .path)
        tags = try? c.decode([String].self, forKey: .tags)
        updatedAt = try? c.decode(String.self, forKey: .updatedAt)
    }
}

/// Nested tree node returned by the /api/folders endpoint.
private struct FolderTreeNode: Codable {
    let id: String
    let name: String
    let children: [FolderTreeNode]?
    // swiftlint:disable:next identifier_name
    let document_count: Int?
}

// MARK: - MemoryView

struct MemoryView: View {
    @Environment(AppState.self) private var appState

    @State private var allFolders: [MemoryFolder] = []
    @State private var documents: [MemoryDocument] = []
    @State private var selectedFolderId: String? = nil
    @State private var selectedDocument: MemoryDocument? = nil
    @State private var documentContent: String = ""
    @State private var searchQuery: String = ""
    @State private var isSearching: Bool = false
    @State private var isLoadingDocs: Bool = false
    @State private var isLoadingContent: Bool = false
    @State private var searchTask: Task<Void, Never>? = nil

    // CRUD state
    @State private var isEditing: Bool = false
    @State private var editTitle: String = ""
    @State private var editContent: String = ""
    @State private var editTags: String = ""
    @State private var showNewDocSheet: Bool = false
    @State private var newDocTitle: String = ""
    @State private var newDocContent: String = ""
    @State private var newDocFolderId: String? = nil
    @State private var newDocTags: String = ""
    @State private var showNewFolderAlert: Bool = false
    @State private var newFolderName: String = ""
    @State private var newFolderParentId: String? = nil
    @State private var showRenameFolderAlert: Bool = false
    @State private var renameFolderTarget: MemoryFolder? = nil
    @State private var renameFolderName: String = ""
    @State private var showDeleteFolderConfirm: Bool = false
    @State private var deleteFolderTarget: MemoryFolder? = nil
    @State private var isSaving: Bool = false

    private var baseURL: String { "\(appState.serverURL)/memory/api" }

    var body: some View {
        if UIDevice.current.userInterfaceIdiom == .pad {
            iPadLayout
        } else {
            iPhoneLayout
        }
    }

    // MARK: - iPad: Three-column split

    private var iPadLayout: some View {
        NavigationSplitView {
            folderTreeSidebar
                .navigationTitle("Memory")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            newFolderParentId = nil
                            newFolderName = ""
                            showNewFolderAlert = true
                        } label: {
                            Image(systemName: "folder.badge.plus")
                                .foregroundStyle(NexusColors.accentText)
                        }
                    }
                }
        } content: {
            documentListView
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showNewDocSheet = true } label: {
                            Image(systemName: "plus")
                                .foregroundStyle(NexusColors.accentText)
                        }
                    }
                }
        } detail: {
            documentDetailView
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showNewDocSheet) {
            newDocumentSheet
        }
        .alert("New Folder", isPresented: $showNewFolderAlert) {
            TextField("Folder name", text: $newFolderName)
            Button("Cancel", role: .cancel) { newFolderName = "" }
            Button("Create") {
                let name = newFolderName.trimmingCharacters(in: .whitespacesAndNewlines)
                let parentId = newFolderParentId
                newFolderName = ""
                if !name.isEmpty {
                    Task { await createFolder(name: name, parentId: parentId) }
                }
            }
        }
        .alert("Rename Folder", isPresented: $showRenameFolderAlert) {
            TextField("Folder name", text: $renameFolderName)
            Button("Cancel", role: .cancel) { renameFolderName = "" }
            Button("Save") {
                let name = renameFolderName.trimmingCharacters(in: .whitespacesAndNewlines)
                if let folder = renameFolderTarget, !name.isEmpty {
                    Task { await renameFolder(folder, newName: name) }
                }
                renameFolderName = ""
                renameFolderTarget = nil
            }
        }
        .alert("Delete Folder?", isPresented: $showDeleteFolderConfirm) {
            Button("Cancel", role: .cancel) { deleteFolderTarget = nil }
            Button("Delete", role: .destructive) {
                if let folder = deleteFolderTarget {
                    Task { await deleteFolder(folder) }
                }
                deleteFolderTarget = nil
            }
        } message: {
            Text("This will permanently delete the folder and its contents.")
        }
    }

    // MARK: - iPhone: Stack navigation

    private var iPhoneLayout: some View {
        NavigationStack {
            VStack(spacing: 0) {
                folderPills
                documentListView
            }
            .navigationTitle("Memory")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showNewDocSheet = true } label: {
                        Image(systemName: "plus")
                            .foregroundStyle(NexusColors.accentText)
                    }
                }
            }
            .navigationDestination(item: $selectedDocument) { _ in
                documentDetailView
                    .navigationTitle(selectedDocument?.title ?? "Document")
                    .navigationBarTitleDisplayMode(.inline)
            }
        }
        .sheet(isPresented: $showNewDocSheet) {
            newDocumentSheet
        }
        .alert("New Folder", isPresented: $showNewFolderAlert) {
            TextField("Folder name", text: $newFolderName)
            Button("Cancel", role: .cancel) { newFolderName = "" }
            Button("Create") {
                let name = newFolderName.trimmingCharacters(in: .whitespacesAndNewlines)
                let parentId = newFolderParentId
                newFolderName = ""
                if !name.isEmpty {
                    Task { await createFolder(name: name, parentId: parentId) }
                }
            }
        }
        .alert("Rename Folder", isPresented: $showRenameFolderAlert) {
            TextField("Folder name", text: $renameFolderName)
            Button("Cancel", role: .cancel) { renameFolderName = "" }
            Button("Save") {
                let name = renameFolderName.trimmingCharacters(in: .whitespacesAndNewlines)
                if let folder = renameFolderTarget, !name.isEmpty {
                    Task { await renameFolder(folder, newName: name) }
                }
                renameFolderName = ""
                renameFolderTarget = nil
            }
        }
        .alert("Delete Folder?", isPresented: $showDeleteFolderConfirm) {
            Button("Cancel", role: .cancel) { deleteFolderTarget = nil }
            Button("Delete", role: .destructive) {
                if let folder = deleteFolderTarget {
                    Task { await deleteFolder(folder) }
                }
                deleteFolderTarget = nil
            }
        } message: {
            Text("This will permanently delete the folder and its contents.")
        }
    }

    // MARK: - New Document Sheet

    private var newDocumentSheet: some View {
        NavigationStack {
            Form {
                Section("Title") {
                    TextField("Document title", text: $newDocTitle)
                        .font(NexusTypography.body)
                }
                Section("Content") {
                    TextEditor(text: $newDocContent)
                        .font(.system(size: 14))
                        .fontDesign(.monospaced)
                        .frame(minHeight: 200)
                }
                Section("Folder") {
                    Picker("Folder", selection: $newDocFolderId) {
                        Text("No folder").tag(String?.none)
                        ForEach(allFolders) { folder in
                            Text(folder.name).tag(Optional(folder.id))
                        }
                    }
                }
                Section("Tags") {
                    TextField("Comma-separated tags", text: $newDocTags)
                        .font(NexusTypography.body)
                }
            }
            .navigationTitle("New Document")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        resetNewDocForm()
                        showNewDocSheet = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let title = newDocTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                        let content = newDocContent
                        let folderId = newDocFolderId
                        let tags = parseTags(newDocTags)
                        resetNewDocForm()
                        showNewDocSheet = false
                        if !title.isEmpty {
                            Task { await createDocument(title: title, content: content, folderId: folderId, tags: tags) }
                        }
                    }
                    .disabled(newDocTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func resetNewDocForm() {
        newDocTitle = ""
        newDocContent = ""
        newDocFolderId = nil
        newDocTags = ""
    }

    private func parseTags(_ raw: String) -> [String] {
        raw.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    // MARK: - Folder Tree Sidebar (iPad)

    /// A flattened folder entry with its tree depth for rendering.
    private struct FlatFolderEntry: Identifiable {
        let folder: MemoryFolder
        let depth: Int
        var id: String { folder.id }
    }

    /// Build a flat, depth-first ordered list of folders for tree display.
    private var flattenedFolderTree: [FlatFolderEntry] {
        var result: [FlatFolderEntry] = []
        func walk(parentId: String?, depth: Int) {
            let children = parentId == nil
                ? allFolders.filter { $0.parentId == nil }.sorted { $0.name < $1.name }
                : allFolders.filter { $0.parentId == parentId }.sorted { $0.name < $1.name }
            for folder in children {
                result.append(FlatFolderEntry(folder: folder, depth: depth))
                walk(parentId: folder.id, depth: depth + 1)
            }
        }
        walk(parentId: nil, depth: 0)
        return result
    }

    private var folderTreeSidebar: some View {
        VStack(spacing: 0) {
            folderTreeItem(id: nil, name: "All Documents", icon: "tray.full", depth: 0, folder: nil)

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(flattenedFolderTree) { entry in
                        folderTreeItem(
                            id: entry.folder.id,
                            name: entry.folder.name,
                            icon: "folder.fill",
                            depth: entry.depth,
                            folder: entry.folder
                        )
                    }
                }
                .padding(.vertical, 4)
            }
            .scrollIndicators(.hidden)
        }
        .background(NexusColors.surface0)
        .task { await loadFolders() }
    }

    private func folderTreeItem(id: String?, name: String, icon: String, depth: Int, folder: MemoryFolder?) -> some View {
        let isActive = selectedFolderId == id
        return Button {
            withAnimation(NexusMotion.base) {
                selectedFolderId = id
                selectedDocument = nil
                documentContent = ""
            }
            Task { await loadDocuments() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .foregroundStyle(isActive ? NexusColors.accentText : NexusColors.text2)
                    .opacity(isActive ? 1 : 0.5)
                Text(name)
                    .font(.system(size: 13))
                    .foregroundStyle(isActive ? NexusColors.text0 : NexusColors.text1)
                    .fontWeight(isActive ? .medium : .regular)
                    .lineLimit(1)
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .padding(.leading, CGFloat(depth) * 16)
            .background(isActive ? NexusColors.accentSofter : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: NexusRadius.sm))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
        .contextMenu {
            if let folder = folder {
                Button {
                    newFolderParentId = folder.id
                    newFolderName = ""
                    showNewFolderAlert = true
                } label: {
                    Label("New Subfolder", systemImage: "folder.badge.plus")
                }
                Button {
                    renameFolderTarget = folder
                    renameFolderName = folder.name
                    showRenameFolderAlert = true
                } label: {
                    Label("Rename", systemImage: "pencil")
                }
                Divider()
                Button(role: .destructive) {
                    deleteFolderTarget = folder
                    showDeleteFolderConfirm = true
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
    }

    // MARK: - Folder hierarchy helpers

    private var rootFolders: [MemoryFolder] {
        allFolders.filter { $0.parentId == nil }.sorted { $0.name < $1.name }
    }

    private func childFolders(of parentId: String) -> [MemoryFolder] {
        allFolders.filter { $0.parentId == parentId }.sorted { $0.name < $1.name }
    }

    // MARK: - Folder Pills (iPhone)

    private var folderPills: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                folderPill(id: nil, name: "All", folder: nil)
                ForEach(rootFolders) { folder in
                    folderPill(id: folder.id, name: folder.name, folder: folder)
                }
                // New folder button pill
                Button {
                    newFolderParentId = nil
                    newFolderName = ""
                    showNewFolderAlert = true
                } label: {
                    Image(systemName: "folder.badge.plus")
                        .font(.system(size: 12))
                        .foregroundStyle(NexusColors.text2)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(NexusColors.surface1)
                        .clipShape(Capsule())
                        .overlay(
                            Capsule()
                                .stroke(NexusColors.glassBorder, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 10)
        }
        .background(NexusColors.surface0)
    }

    private func folderPill(id: String?, name: String, folder: MemoryFolder?) -> some View {
        let isActive = selectedFolderId == id
        return Button {
            withAnimation(NexusMotion.base) { selectedFolderId = id }
            Task { await loadDocuments() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: id == nil ? "tray.full" : "folder.fill")
                    .font(.system(size: 12))
                Text(name)
                    .font(.system(size: 13, weight: .medium))
            }
            .foregroundStyle(isActive ? NexusColors.accentText : NexusColors.text1)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(isActive ? NexusColors.accentSoft : NexusColors.surface1)
            .clipShape(Capsule())
            .overlay(
                Capsule()
                    .stroke(isActive ? NexusColors.accent : NexusColors.glassBorder, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .contextMenu {
            if let folder = folder {
                Button {
                    newFolderParentId = folder.id
                    newFolderName = ""
                    showNewFolderAlert = true
                } label: {
                    Label("New Subfolder", systemImage: "folder.badge.plus")
                }
                Button {
                    renameFolderTarget = folder
                    renameFolderName = folder.name
                    showRenameFolderAlert = true
                } label: {
                    Label("Rename", systemImage: "pencil")
                }
                Divider()
                Button(role: .destructive) {
                    deleteFolderTarget = folder
                    showDeleteFolderConfirm = true
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
    }

    // MARK: - Document List

    private var documentListView: some View {
        VStack(spacing: 0) {
            // Search bar
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(NexusColors.text2)
                    .font(.system(size: 14))
                TextField("Search documents...", text: $searchQuery)
                    .font(NexusTypography.body)
                    .foregroundStyle(NexusColors.text0)
                    .onSubmit { Task { await searchDocuments() } }
                    .onChange(of: searchQuery) { _, newQuery in
                        searchTask?.cancel()
                        if newQuery.isEmpty {
                            isSearching = false
                            Task { await loadDocuments() }
                        } else {
                            searchTask = Task {
                                try? await Task.sleep(for: .milliseconds(300))
                                if !Task.isCancelled { await searchDocuments() }
                            }
                        }
                    }
                if !searchQuery.isEmpty {
                    Button {
                        searchQuery = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(NexusColors.text2)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .background(NexusColors.surface1)
            .clipShape(RoundedRectangle(cornerRadius: NexusRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: NexusRadius.md)
                    .stroke(NexusColors.glassBorder)
            )
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 8)

            if isLoadingDocs {
                Spacer()
                NexusThinkingDots()
                Spacer()
            } else if documents.isEmpty {
                Spacer()
                VStack(spacing: 12) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 32))
                        .foregroundStyle(NexusColors.text2)
                    Text(isSearching ? "No results found" : "No documents")
                        .font(NexusTypography.body)
                        .foregroundStyle(NexusColors.text2)
                }
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(documents) { doc in
                            documentRow(doc)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 16)
                }
                .scrollIndicators(.hidden)
            }
        }
        .background(NexusColors.void)
        .task {
            await loadFolders()
            await loadDocuments()
        }
    }

    private func documentRow(_ doc: MemoryDocument) -> some View {
        let isSelected = selectedDocument?.id == doc.id
        return Button {
            isEditing = false
            selectedDocument = doc
            Task { await loadDocumentContent(doc) }
        } label: {
            HStack(alignment: .top, spacing: 14) {
                ZStack {
                    RoundedRectangle(cornerRadius: NexusRadius.sm)
                        .fill(NexusColors.accentSofter)
                        .frame(width: 36, height: 36)
                    Image(systemName: "doc.text.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(NexusColors.accentText)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text(doc.title)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(NexusColors.text0)
                        .lineLimit(1)
                    Text(doc.path)
                        .font(NexusTypography.jetBrainsMono(size: 11))
                        .foregroundStyle(NexusColors.text2)
                        .lineLimit(1)
                    if let snippet = doc.snippet, !snippet.isEmpty {
                        Text(snippet)
                            .font(NexusTypography.jetBrainsMono(size: 11))
                            .foregroundStyle(NexusColors.text2)
                            .lineLimit(2)
                    }
                    if !doc.tags.isEmpty {
                        HStack(spacing: 4) {
                            ForEach(doc.tags.prefix(3), id: \.self) { tag in
                                Text(tag)
                                    .font(.system(size: 10))
                                    .foregroundStyle(NexusColors.text1)
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 2)
                                    .background(NexusColors.surface2)
                                    .clipShape(Capsule())
                            }
                        }
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(isSelected ? NexusColors.surfaceHover : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: NexusRadius.md))
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                Task { await deleteDocument(doc) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
            .tint(NexusColors.red)
        }
    }

    // MARK: - Document Viewer / Editor

    private var documentDetailView: some View {
        Group {
            if let doc = selectedDocument {
                if isEditing {
                    documentEditView(doc)
                } else {
                    documentReadView(doc)
                }
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 40))
                        .foregroundStyle(NexusColors.text2)
                    Text("Select a document")
                        .font(NexusTypography.body)
                        .foregroundStyle(NexusColors.text2)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(NexusColors.void)
            }
        }
    }

    private func documentReadView(_ doc: MemoryDocument) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // Header
                VStack(alignment: .leading, spacing: 10) {
                    Text(doc.title)
                        .font(.system(size: 26, weight: .bold))
                        .foregroundStyle(NexusColors.text0)
                        .tracking(-0.6)
                    HStack(spacing: 18) {
                        Text(doc.path)
                            .font(NexusTypography.jetBrainsMono(size: 12))
                            .foregroundStyle(NexusColors.text2)
                        if let updated = doc.updatedAt {
                            Text(updated)
                                .font(NexusTypography.jetBrainsMono(size: 12))
                                .foregroundStyle(NexusColors.text2)
                        }
                    }
                    if !doc.tags.isEmpty {
                        HStack(spacing: 6) {
                            ForEach(doc.tags, id: \.self) { tag in
                                Text(tag)
                                    .font(.system(size: 11))
                                    .foregroundStyle(NexusColors.text1)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(NexusColors.surface2)
                                    .clipShape(Capsule())
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, iPadDetailPadding)
                .padding(.top, 36)
                .padding(.bottom, 20)

                Divider().background(NexusColors.glassBorder)

                if isLoadingContent {
                    HStack {
                        Spacer()
                        NexusThinkingDots()
                        Spacer()
                    }
                    .padding(.top, 40)
                } else {
                    Markdown(documentContent)
                        .markdownTheme(.nexus)
                        .textSelection(.enabled)
                        .padding(.horizontal, iPadDetailPadding)
                        .padding(.vertical, 28)
                }
            }
        }
        .scrollIndicators(.hidden)
        .background(NexusColors.void)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    editTitle = doc.title
                    editContent = documentContent
                    editTags = doc.tags.joined(separator: ", ")
                    isEditing = true
                } label: {
                    Image(systemName: "pencil")
                        .foregroundStyle(NexusColors.accentText)
                }
            }
        }
    }

    private func documentEditView(_ doc: MemoryDocument) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // Editable title
            TextField("Title", text: $editTitle)
                .font(.system(size: 26, weight: .bold))
                .foregroundStyle(NexusColors.text0)
                .padding(.horizontal, iPadDetailPadding)
                .padding(.top, 36)
                .padding(.bottom, 8)

            // Editable tags
            HStack(spacing: 8) {
                Image(systemName: "tag")
                    .font(.system(size: 12))
                    .foregroundStyle(NexusColors.text2)
                TextField("Tags (comma-separated)", text: $editTags)
                    .font(NexusTypography.jetBrainsMono(size: 12))
                    .foregroundStyle(NexusColors.text1)
            }
            .padding(.horizontal, iPadDetailPadding)
            .padding(.bottom, 16)

            Divider().background(NexusColors.glassBorder)

            // Editable content
            TextEditor(text: $editContent)
                .font(.system(size: 14))
                .fontDesign(.monospaced)
                .foregroundStyle(NexusColors.text0)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, iPadDetailPadding - 5) // TextEditor has internal padding
                .padding(.vertical, 12)
        }
        .background(NexusColors.void)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") {
                    isEditing = false
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                if isSaving {
                    ProgressView()
                } else {
                    Button("Save") {
                        let title = editTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                        let content = editContent
                        let tags = parseTags(editTags)
                        if !title.isEmpty {
                            Task {
                                await updateDocument(id: doc.id, title: title, content: content, tags: tags)
                                isEditing = false
                            }
                        }
                    }
                    .disabled(editTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private var iPadDetailPadding: CGFloat {
        UIDevice.current.userInterfaceIdiom == .pad ? 48 : 20
    }

    // MARK: - API Calls (Read)

    private func loadFolders() async {
        guard let url = URL(string: "\(baseURL)/folders") else { return }
        var req = URLRequest(url: url)
        if let token = appState.auth.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            // API returns a nested tree: {id, name, children: [...]}
            // Try to decode as a tree node first, then flatten
            if let treeRoot = try? JSONDecoder().decode(FolderTreeNode.self, from: data) {
                let flattened = flattenFolderTree(node: treeRoot, parentId: nil)
                await MainActor.run { allFolders = flattened }
            } else if let flatList = try? JSONDecoder().decode([MemoryFolder].self, from: data) {
                // Fallback: already flat
                await MainActor.run { allFolders = flatList }
            }
        } catch {
            print("[Memory] Folders error: \(error)")
        }
    }

    /// Flatten a nested folder tree into a flat array of MemoryFolder with parentId.
    private func flattenFolderTree(node: FolderTreeNode, parentId: String?) -> [MemoryFolder] {
        var result: [MemoryFolder] = []
        // Skip the virtual root node (id == "root"), only add its children as root-level
        let isVirtualRoot = (parentId == nil && node.id == "root")
        if !isVirtualRoot {
            result.append(MemoryFolder(id: node.id, name: node.name, parentId: parentId))
        }
        for child in node.children ?? [] {
            let childParent = isVirtualRoot ? nil : node.id
            result.append(contentsOf: flattenFolderTree(node: child, parentId: childParent))
        }
        return result
    }

    private func loadDocuments() async {
        isSearching = false
        await MainActor.run { isLoadingDocs = true; documents = [] }
        var urlStr = "\(baseURL)/documents"
        if let fid = selectedFolderId { urlStr += "?folder_id=\(fid)" }
        guard let url = URL(string: urlStr) else { return }
        var req = URLRequest(url: url)
        if let token = appState.auth.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            let loaded = try decodeDocumentList(from: data)
            await MainActor.run { documents = loaded; isLoadingDocs = false }
        } catch {
            await MainActor.run { isLoadingDocs = false }
            print("[Memory] Docs error: \(error)")
        }
    }

    private func searchDocuments() async {
        guard !searchQuery.isEmpty else { return }
        await MainActor.run { isSearching = true; isLoadingDocs = true; documents = [] }
        guard let encoded = searchQuery.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(baseURL)/search?q=\(encoded)") else { return }
        var req = URLRequest(url: url)
        if let token = appState.auth.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            let loaded = try decodeDocumentList(from: data)
            await MainActor.run { documents = loaded; isLoadingDocs = false }
        } catch {
            await MainActor.run { isLoadingDocs = false }
            print("[Memory] Search error: \(error)")
        }
    }

    private func loadDocumentContent(_ doc: MemoryDocument) async {
        await MainActor.run { isLoadingContent = true; documentContent = "" }
        guard let url = URL(string: "\(baseURL)/documents/\(doc.id)") else { return }
        var req = URLRequest(url: url)
        if let token = appState.auth.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            if let full = try? JSONDecoder().decode(MemoryDocumentFull.self, from: data) {
                await MainActor.run { documentContent = full.content ?? ""; isLoadingContent = false }
            } else if let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let content = dict["content"] as? String {
                await MainActor.run { documentContent = content; isLoadingContent = false }
            } else {
                await MainActor.run { isLoadingContent = false }
            }
        } catch {
            await MainActor.run { isLoadingContent = false }
            print("[Memory] Content error: \(error)")
        }
    }

    /// Decode a document list that may come as a raw array, or wrapped in {documents: [...]}, {results: [...]}.
    private func decodeDocumentList(from data: Data) throws -> [MemoryDocument] {
        // Try raw array first
        if let list = try? JSONDecoder().decode([MemoryDocument].self, from: data) {
            return list
        }
        // Try wrapped forms
        if let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let jsonArray = dict["documents"] ?? dict["results"] ?? dict["data"]
            if let arrayData = jsonArray,
               let reEncoded = try? JSONSerialization.data(withJSONObject: arrayData),
               let list = try? JSONDecoder().decode([MemoryDocument].self, from: reEncoded) {
                return list
            }
        }
        return []
    }

    // MARK: - API Calls (CRUD)

    private func createDocument(title: String, content: String, folderId: String?, tags: [String]) async {
        guard let url = URL(string: "\(baseURL)/documents") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = appState.auth.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        var body: [String: Any] = ["title": title, "content": content]
        if let fid = folderId { body["folder_id"] = fid }
        if !tags.isEmpty { body["tags"] = tags }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        await MainActor.run { isSaving = true }
        do {
            let (_, _) = try await URLSession.shared.data(for: req)
            await loadDocuments()
        } catch {
            print("[Memory] Create doc error: \(error)")
        }
        await MainActor.run { isSaving = false }
    }

    private func updateDocument(id: String, title: String, content: String, tags: [String]) async {
        guard let url = URL(string: "\(baseURL)/documents/\(id)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = appState.auth.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let body: [String: Any] = ["title": title, "content": content, "tags": tags]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        await MainActor.run { isSaving = true }
        do {
            let (_, _) = try await URLSession.shared.data(for: req)
            // Reload document content to reflect saved changes
            await MainActor.run {
                documentContent = content
            }
            await loadDocuments()
            // Re-select the updated document in the list
            if let updated = documents.first(where: { $0.id == id }) {
                await MainActor.run { selectedDocument = updated }
            }
        } catch {
            print("[Memory] Update doc error: \(error)")
        }
        await MainActor.run { isSaving = false }
    }

    private func deleteDocument(_ doc: MemoryDocument) async {
        guard let url = URL(string: "\(baseURL)/documents/\(doc.id)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        if let token = appState.auth.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (_, _) = try await URLSession.shared.data(for: req)
            await MainActor.run {
                documents.removeAll { $0.id == doc.id }
                if selectedDocument?.id == doc.id {
                    selectedDocument = nil
                    documentContent = ""
                    isEditing = false
                }
            }
        } catch {
            print("[Memory] Delete doc error: \(error)")
        }
    }

    private func createFolder(name: String, parentId: String?) async {
        guard let url = URL(string: "\(baseURL)/folders") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = appState.auth.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        var body: [String: Any] = ["name": name]
        if let pid = parentId { body["parent_id"] = pid }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (_, _) = try await URLSession.shared.data(for: req)
            await loadFolders()
        } catch {
            print("[Memory] Create folder error: \(error)")
        }
    }

    private func renameFolder(_ folder: MemoryFolder, newName: String) async {
        guard let url = URL(string: "\(baseURL)/folders/\(folder.id)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = appState.auth.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let body: [String: Any] = ["name": newName]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (_, _) = try await URLSession.shared.data(for: req)
            await loadFolders()
        } catch {
            print("[Memory] Rename folder error: \(error)")
        }
    }

    private func deleteFolder(_ folder: MemoryFolder) async {
        guard let url = URL(string: "\(baseURL)/folders/\(folder.id)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        if let token = appState.auth.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (_, _) = try await URLSession.shared.data(for: req)
            await MainActor.run {
                if selectedFolderId == folder.id {
                    selectedFolderId = nil
                }
            }
            await loadFolders()
            await loadDocuments()
        } catch {
            print("[Memory] Delete folder error: \(error)")
        }
    }
}
