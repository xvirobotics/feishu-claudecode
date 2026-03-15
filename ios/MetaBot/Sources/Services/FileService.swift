import Foundation

/// Handles file upload and URL construction
struct FileService {
    let serverURL: String
    let token: String

    /// Upload a file to the server
    func upload(data: Data, filename: String, mimeType: String, chatId: String) async throws -> (serverFilename: String, path: String) {
        var components = URLComponents(string: "\(serverURL)/api/upload")!
        components.queryItems = [
            URLQueryItem(name: "filename", value: filename),
            URLQueryItem(name: "chatId", value: chatId),
            URLQueryItem(name: "token", value: token),
        ]

        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = data

        let (responseData, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw FileServiceError.uploadFailed
        }

        struct UploadResponse: Decodable {
            let filename: String
            let path: String
        }

        let result = try JSONDecoder().decode(UploadResponse.self, from: responseData)
        return (result.filename, result.path)
    }

    /// Build full URL for a file
    func fileURL(chatId: String, filename: String) -> URL? {
        URL(string: "\(serverURL)/api/files/\(chatId)/\(filename)")
    }

    /// Build full URL from a relative path
    func absoluteURL(_ relativePath: String) -> URL? {
        URL(string: "\(serverURL)\(relativePath)")
    }
}

enum FileServiceError: Error, LocalizedError {
    case uploadFailed

    var errorDescription: String? {
        switch self {
        case .uploadFailed: return "File upload failed"
        }
    }
}
