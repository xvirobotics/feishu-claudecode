import Foundation

/// File attachment on a message
struct FileAttachment: Codable, Identifiable, Hashable {
    var id: String { url }
    let name: String
    let type: String
    let size: Int?
    let url: String
    let path: String?

    /// File category based on MIME type
    var category: FileCategory {
        if type.hasPrefix("image/") { return .image }
        if type.hasPrefix("video/") { return .video }
        if type.hasPrefix("audio/") { return .audio }
        return .other
    }

    /// File extension
    var fileExtension: String {
        let ext = (name as NSString).pathExtension.lowercased()
        return ext.isEmpty ? "?" : ext
    }

    /// Formatted file size
    var formattedSize: String {
        guard let size else { return "" }
        if size < 1024 { return "\(size) B" }
        if size < 1024 * 1024 { return String(format: "%.1f KB", Double(size) / 1024) }
        return String(format: "%.1f MB", Double(size) / (1024 * 1024))
    }
}

enum FileCategory {
    case image, video, audio, other
}
