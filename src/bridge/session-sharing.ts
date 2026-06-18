/**
 * In-memory store for pending session transfers between Feishu users.
 *
 * Flow:
 *   1. User A: `/share-session @用户B` → creates a pending transfer record,
 *      keyed by target userId. Also generates a short share code so User B
 *      can claim it explicitly via `/claim <code>`.
 *   2. User B sends ANY message to the bot → the bridge checks for a
 *      pending transfer before creating a new session. If found, the
 *      target user's session is linked to the source session (same
 *      Claude sessionId), and the pending record is consumed.
 *   3. User B can also use `/claim <code>` explicitly.
 *
 * Transfers expire after 30 minutes of inactivity.
 */

const TRANSFER_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface PendingTransfer {
  /** scopeKey of the source user (chatId:userId). */
  sourceScopeKey: string;
  /** sessionId from the source session — what we'll copy to the target. */
  sessionId: string;
  /** Feishu open_id of the target user. */
  targetUserId: string;
  /** Short human-readable code for explicit claim. */
  shareCode: string;
  /** When this transfer was created. */
  createdAt: number;
}

function generateShareCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export class SessionSharing {
  /** Pending transfers keyed by target userId (auto-claim on first message). */
  private byUserId = new Map<string, PendingTransfer>();
  /** Pending transfers keyed by shareCode (explicit /claim). */
  private byCode = new Map<string, PendingTransfer>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Periodic cleanup every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Create a pending session transfer. Returns the share code for the
   * source user to share with the target user.
   */
  createTransfer(sourceScopeKey: string, sessionId: string, targetUserId: string): string {
    const shareCode = generateShareCode();
    const transfer: PendingTransfer = {
      sourceScopeKey,
      sessionId,
      targetUserId,
      shareCode,
      createdAt: Date.now(),
    };
    this.byUserId.set(targetUserId, transfer);
    this.byCode.set(shareCode, transfer);
    return shareCode;
  }

  /**
   * Check if there's a pending transfer for this userId.
   * Returns the transfer WITHOUT consuming it — call claimByUserId to consume.
   */
  getPendingByUserId(userId: string): PendingTransfer | undefined {
    const transfer = this.byUserId.get(userId);
    if (!transfer) return undefined;
    if (Date.now() - transfer.createdAt > TRANSFER_TTL_MS) {
      this.byUserId.delete(userId);
      this.byCode.delete(transfer.shareCode);
      return undefined;
    }
    return transfer;
  }

  /**
   * Claim a pending transfer by target userId. Removes the transfer
   * record so it can't be claimed twice. Returns undefined if expired.
   */
  claimByUserId(userId: string): PendingTransfer | undefined {
    const transfer = this.getPendingByUserId(userId);
    if (transfer) {
      this.byUserId.delete(userId);
      this.byCode.delete(transfer.shareCode);
    }
    return transfer;
  }

  /**
   * Claim a pending transfer by share code. Removes the transfer
   * record so it can't be claimed twice. Returns undefined if expired
   * or not found.
   */
  claimByCode(shareCode: string): PendingTransfer | undefined {
    const transfer = this.byCode.get(shareCode);
    if (!transfer) return undefined;
    if (Date.now() - transfer.createdAt > TRANSFER_TTL_MS) {
      this.byUserId.delete(transfer.targetUserId);
      this.byCode.delete(shareCode);
      return undefined;
    }
    this.byUserId.delete(transfer.targetUserId);
    this.byCode.delete(shareCode);
    return transfer;
  }

  /** Remove expired transfers. */
  private cleanup(): void {
    const now = Date.now();
    for (const [userId, transfer] of this.byUserId) {
      if (now - transfer.createdAt > TRANSFER_TTL_MS) {
        this.byUserId.delete(userId);
        this.byCode.delete(transfer.shareCode);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}
