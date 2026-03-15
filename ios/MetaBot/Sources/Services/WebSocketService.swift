import Foundation
import Observation

/// Connection state
enum ConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
}

/// WebSocket service for real-time communication with MetaBot server
@Observable
final class WebSocketService: NSObject, @unchecked Sendable {
    private(set) var connectionState: ConnectionState = .disconnected
    var isConnected: Bool { connectionState == .connected }

    private var webSocketTask: URLSessionWebSocketTask?
    private var session: URLSession?
    private var serverURL: String = ""
    private var token: String = ""
    private var heartbeatTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var reconnectDelay: TimeInterval = 1.0
    private var intentionalDisconnect = false

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    /// Stream of incoming server messages
    private var messageContinuation: AsyncStream<ServerMessage>.Continuation?
    private(set) var messageStream: AsyncStream<ServerMessage>!

    override init() {
        super.init()
        resetStream()
    }

    private func resetStream() {
        messageStream = AsyncStream { [weak self] continuation in
            self?.messageContinuation = continuation
        }
    }

    // MARK: - Connect / Disconnect

    func connect(serverURL: String, token: String) {
        self.serverURL = serverURL
        self.token = token
        intentionalDisconnect = false
        reconnectDelay = 1.0
        doConnect()
    }

    func disconnect() {
        intentionalDisconnect = true
        cleanup()
        connectionState = .disconnected
    }

    private func doConnect() {
        cleanup()

        let wsScheme = serverURL.hasPrefix("https") ? "wss" : "ws"
        let host = serverURL
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        guard let url = URL(string: "\(wsScheme)://\(host)/ws?token=\(token)") else {
            connectionState = .disconnected
            return
        }

        connectionState = .connecting
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        webSocketTask = session?.webSocketTask(with: url)
        webSocketTask?.resume()

        startReceiving()
        startHeartbeat()
    }

    private func cleanup() {
        heartbeatTask?.cancel()
        heartbeatTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        session?.invalidateAndCancel()
        session = nil
    }

    // MARK: - Send

    func send(_ message: ClientMessage) {
        guard let task = webSocketTask else { return }
        do {
            let data = try encoder.encode(message)
            task.send(.string(String(data: data, encoding: .utf8) ?? "")) { error in
                if let error {
                    print("[WS] Send error: \(error.localizedDescription)")
                }
            }
        } catch {
            print("[WS] Encode error: \(error)")
        }
    }

    // MARK: - Receive

    private func startReceiving() {
        receiveTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                guard let task = self.webSocketTask else { break }
                do {
                    let message = try await task.receive()
                    switch message {
                    case .string(let text):
                        self.handleText(text)
                    case .data(let data):
                        self.handleData(data)
                    @unknown default:
                        break
                    }
                } catch {
                    if !Task.isCancelled && !self.intentionalDisconnect {
                        await MainActor.run {
                            self.connectionState = .disconnected
                        }
                        self.scheduleReconnect()
                    }
                    break
                }
            }
        }
    }

    private func handleText(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        handleData(data)
    }

    private func handleData(_ data: Data) {
        do {
            let message = try decoder.decode(ServerMessage.self, from: data)

            switch message {
            case .connected:
                Task { @MainActor in
                    self.connectionState = .connected
                    self.reconnectDelay = 1.0
                }
            case .pong:
                break // heartbeat response, no action needed
            default:
                break
            }

            messageContinuation?.yield(message)
        } catch {
            print("[WS] Decode error: \(error) for: \(String(data: data, encoding: .utf8) ?? "?")")
        }
    }

    // MARK: - Heartbeat

    private func startHeartbeat() {
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(25))
                guard !Task.isCancelled else { break }
                self?.send(.ping)
            }
        }
    }

    // MARK: - Reconnect

    private func scheduleReconnect() {
        guard !intentionalDisconnect else { return }
        reconnectTask = Task { [weak self] in
            guard let self else { return }
            let delay = self.reconnectDelay
            print("[WS] Reconnecting in \(delay)s...")
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled && !self.intentionalDisconnect else { return }
            self.reconnectDelay = min(self.reconnectDelay * 2, 30)
            // Don't resetStream() here — AppState is still iterating the existing stream.
            // The same continuation is reused across reconnections.
            self.doConnect()
        }
    }
}

// MARK: - URLSessionWebSocketDelegate

extension WebSocketService: URLSessionWebSocketDelegate {
    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        print("[WS] Connected")
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        print("[WS] Closed: \(closeCode)")
        if !intentionalDisconnect {
            Task { @MainActor in
                self.connectionState = .disconnected
            }
            scheduleReconnect()
        }
    }
}
