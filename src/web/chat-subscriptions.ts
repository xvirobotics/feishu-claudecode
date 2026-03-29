import { WebSocket } from 'ws';

/**
 * Pub/sub manager: maps chatId → Set<WebSocket>.
 * Enables `mb talk` API and group chat to stream responses to WS clients
 * that are watching a given chatId.
 */
export class ChatSubscriptionManager {
  private subs = new Map<string, Set<WebSocket>>();

  /** Subscribe a WS client to updates for a chatId. */
  subscribe(chatId: string, ws: WebSocket): void {
    let set = this.subs.get(chatId);
    if (!set) {
      set = new Set();
      this.subs.set(chatId, set);
    }
    set.add(ws);
  }

  /** Remove a WS client from all subscriptions (call on disconnect). */
  unsubscribeAll(ws: WebSocket): void {
    for (const [chatId, set] of this.subs) {
      set.delete(ws);
      if (set.size === 0) this.subs.delete(chatId);
    }
  }

  /** Get all subscribers for a chatId. */
  getSubscribers(chatId: string): Set<WebSocket> | undefined {
    return this.subs.get(chatId);
  }

  /** Broadcast a JSON message to all subscribers of a chatId. */
  broadcast(chatId: string, message: object): void {
    const set = this.subs.get(chatId);
    if (!set || set.size === 0) return;
    const data = JSON.stringify(message);
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }
}
