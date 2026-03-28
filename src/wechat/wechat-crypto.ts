import * as crypto from 'node:crypto';

/**
 * Encrypt a buffer using AES-128-ECB (required by WeChat iLink CDN).
 * Returns { encrypted, key } where key is the randomly generated 128-bit key.
 */
export function encryptMedia(data: Buffer): { encrypted: Buffer; key: Buffer } {
  const key = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return { encrypted, key };
}

/**
 * Decrypt a buffer using AES-128-ECB with the provided key.
 */
export function decryptMedia(data: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * Generate the X-WECHAT-UIN header value: base64(String(randomUint32)).
 */
export function generateWechatUin(): string {
  const num = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(num)).toString('base64');
}
