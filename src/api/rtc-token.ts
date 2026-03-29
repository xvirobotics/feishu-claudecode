/**
 * Volcengine RTC AccessToken generator.
 * Ported from: https://github.com/volcengine/rtc-aigc-demo/blob/main/Server/token.js
 * License: BSD-3-Clause (Copyright 2025 Beijing Volcano Engine Technology Co., Ltd.)
 */
import * as crypto from 'node:crypto';

const VERSION = '001';

export enum Privileges {
  PrivPublishStream = 0,
  PrivPublishAudioStream = 1,
  PrivPublishVideoStream = 2,
  PrivPublishDataStream = 3,
  PrivSubscribeStream = 4,
}

// ---------- Binary helpers ----------

class ByteBuf {
  private buffer = Buffer.alloc(2048);
  private position = 0;

  pack(): Buffer {
    return this.buffer.subarray(0, this.position);
  }

  putUint16(v: number): this {
    this.buffer.writeUInt16LE(v, this.position);
    this.position += 2;
    return this;
  }

  putUint32(v: number): this {
    this.buffer.writeUInt32LE(v, this.position);
    this.position += 4;
    return this;
  }

  putBytes(bytes: Buffer): this {
    this.putUint16(bytes.length);
    bytes.copy(this.buffer, this.position);
    this.position += bytes.length;
    return this;
  }

  putString(str: string): this {
    return this.putBytes(Buffer.from(str));
  }

  putTreeMapUInt32(map: Record<number, number>): this {
    const keys = Object.keys(map);
    this.putUint16(keys.length);
    for (const key of keys) {
      this.putUint16(Number(key));
      this.putUint32(map[Number(key)]);
    }
    return this;
  }
}

// ---------- AccessToken ----------

function encodeHMac(key: string, message: Buffer): Buffer {
  return crypto.createHmac('sha256', key).update(message).digest();
}

function packMsg(
  nonce: number,
  issuedAt: number,
  expireAt: number,
  roomId: string,
  userId: string,
  privileges: Record<number, number>,
): Buffer {
  const buf = new ByteBuf();
  buf.putUint32(nonce);
  buf.putUint32(issuedAt);
  buf.putUint32(expireAt);
  buf.putString(roomId);
  buf.putString(userId);
  buf.putTreeMapUInt32(privileges);
  return buf.pack();
}

/**
 * Generate a Volcengine RTC access token.
 *
 * @param appId   RTC App ID
 * @param appKey  RTC App Key (HMAC secret)
 * @param roomId  Room to join
 * @param userId  User identity in room
 * @param ttlSeconds  Token lifetime (default 1 hour)
 */
export function generateRtcToken(
  appId: string,
  appKey: string,
  roomId: string,
  userId: string,
  ttlSeconds = 3600,
): string {
  const now = Math.floor(Date.now() / 1000);
  const expireAt = now + ttlSeconds;
  const nonce = Math.floor(Math.random() * 0xffffffff);

  // Grant both publish and subscribe privileges
  const privs: Record<number, number> = {
    [Privileges.PrivPublishStream]: expireAt,
    [Privileges.PrivPublishAudioStream]: expireAt,
    [Privileges.PrivPublishVideoStream]: expireAt,
    [Privileges.PrivPublishDataStream]: expireAt,
    [Privileges.PrivSubscribeStream]: expireAt,
  };

  const bytesM = packMsg(nonce, now, expireAt, roomId, userId, privs);
  const signature = encodeHMac(appKey, bytesM);

  const content = new ByteBuf();
  content.putBytes(bytesM);
  content.putBytes(signature);

  return VERSION + appId + content.pack().toString('base64');
}
