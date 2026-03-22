/**
 * Volcengine Streaming ASR — Bidirectional WebSocket proxy
 *
 * Connects to wss://openspeech.bytedance.com/api/v3/sauc/bigmodel
 * using the Volcengine binary frame protocol. Receives raw PCM 16kHz
 * 16-bit mono audio from the browser (via MetaBot's /ws) and streams
 * partial transcripts back in real time.
 */

import { WebSocket } from 'ws';
import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import type { Logger } from 'pino';

const VOLCENGINE_ASR_WS_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';
const CONNECTION_TIMEOUT_MS = 10_000;
const GRACEFUL_CLOSE_DELAY_MS = 3_000;

// ── Public types ──

export interface ASRTranscriptEvent {
  text: string;
  isFinal: boolean;
}

export interface StreamingASRSessionOptions {
  appKey: string;
  accessKey: string;
  logger: Logger;
  onTranscript: (event: ASRTranscriptEvent) => void;
  onError: (error: string) => void;
  onClose: () => void;
}

// ── Volcengine binary protocol helpers ──
// Based on the official SDK: https://github.com/volcengine/ai-app-lab/blob/main/arkitect/utils/binary_protocol.py
//
// Header format (4 bytes):
//   byte 0: (protocol_version << 4) | header_size   → 0x11 (v1, 1×4=4 bytes header)
//   byte 1: (message_type << 4) | message_type_specific_flags
//   byte 2: (serialization_method << 4) | compression_type
//   byte 3: reserved (0x00)
//
// Message types: FULL_CLIENT_REQUEST=0x1, AUDIO_ONLY_REQUEST=0x2,
//                FULL_SERVER_RESPONSE=0x9, SERVER_ERROR=0xF
// Flags: NO_SEQUENCE=0x0, POS_SEQUENCE=0x1
// Serialization: NONE=0x0, JSON=0x1
// Compression: NONE=0x0, GZIP=0x1

/** Pack a full client request (config JSON, gzip-compressed, with sequence=1) */
function packConfigFrame(config: object): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0x11; // version=1, header_size=1
  header[1] = 0x11; // FULL_CLIENT_REQUEST=1, POS_SEQUENCE=1
  header[2] = 0x11; // JSON=1, GZIP=1
  header[3] = 0x00;

  const jsonBytes = Buffer.from(JSON.stringify(config), 'utf-8');
  const compressed = zlib.gzipSync(jsonBytes);

  const sequence = Buffer.alloc(4);
  sequence.writeInt32BE(1, 0); // sequence=1

  const payloadSize = Buffer.alloc(4);
  payloadSize.writeUInt32BE(compressed.length, 0);

  return Buffer.concat([header, sequence, payloadSize, compressed]);
}

/** Pack an audio-only frame (gzip-compressed PCM, with payload size) */
function packAudioFrame(pcmData: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0x11; // version=1, header_size=1
  header[1] = 0x20; // AUDIO_ONLY_REQUEST=2, NO_SEQUENCE=0
  header[2] = 0x11; // JSON=1, GZIP=1 (matches SDK defaults)
  header[3] = 0x00;

  const compressed = zlib.gzipSync(pcmData);
  const payloadSize = Buffer.alloc(4);
  payloadSize.writeUInt32BE(compressed.length, 0);

  return Buffer.concat([header, payloadSize, compressed]);
}

/** Parse a server response frame, return JSON payload or null */
function parseServerFrame(data: Buffer): { type: 'response' | 'error'; payload: any } | null {
  if (data.length < 4) return null;

  const headerSize = data[0] & 0x0f;
  const msgType = (data[1] >> 4) & 0x0f;
  const flags = data[1] & 0x0f;
  const _serialization = (data[2] >> 4) & 0x0f;
  const compression = data[2] & 0x0f;

  let payload = data.subarray(headerSize * 4);

  // If POS_SEQUENCE flag is set, skip the 4-byte sequence number
  if (flags & 0x01) {
    payload = payload.subarray(4);
  }

  if (msgType === 0x09) {
    // Full server response: [4-byte payload_size][payload]
    if (payload.length < 4) return null;
    const payloadSize = payload.readUInt32BE(0);
    let payloadMsg = payload.subarray(4, 4 + payloadSize);
    if (compression === 0x01) payloadMsg = zlib.gunzipSync(payloadMsg);
    try {
      return { type: 'response', payload: JSON.parse(payloadMsg.toString('utf-8')) };
    } catch { return null; }
  }

  if (msgType === 0x0f) {
    // Server error: [4-byte error_code][4-byte payload_size][payload]
    if (payload.length < 8) return null;
    const payloadSize = payload.readUInt32BE(4);
    let payloadMsg = payload.subarray(8, 8 + payloadSize);
    if (compression === 0x01) payloadMsg = zlib.gunzipSync(payloadMsg);
    try {
      return { type: 'error', payload: JSON.parse(payloadMsg.toString('utf-8')) };
    } catch {
      return { type: 'error', payload: { error: payloadMsg.toString('utf-8') } };
    }
  }

  return null;
}

// ── StreamingASRSession ──

export class StreamingASRSession {
  private ws: WebSocket | null = null;
  private closed = false;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private opts: StreamingASRSessionOptions;
  private connectId: string;

  constructor(opts: StreamingASRSessionOptions) {
    this.opts = opts;
    this.connectId = crypto.randomUUID();
  }

  /** Open WebSocket to Volcengine and send initial config */
  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(VOLCENGINE_ASR_WS_URL, {
        headers: {
          'X-Api-App-Key': this.opts.appKey,
          'X-Api-Access-Key': this.opts.accessKey,
          'X-Api-Resource-Id': 'volc.bigasr.sauc.duration',
          'X-Api-Connect-Id': this.connectId,
        },
      });
      ws.binaryType = 'nodebuffer';

      const timeout = setTimeout(() => {
        if (!this.ws) {
          ws.terminate();
          reject(new Error('Volcengine ASR connection timeout'));
        }
      }, CONNECTION_TIMEOUT_MS);

      let initResolved = false;

      ws.on('open', () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.sendInitialConfig();
      });

      ws.on('message', (raw: Buffer) => {
        const frame = parseServerFrame(raw);
        if (!frame) return;

        if (frame.type === 'response') {
          // First response = config ACK, resolve the start() promise
          if (!initResolved) {
            initResolved = true;
            this.opts.logger.info({ connectId: this.connectId }, 'Streaming ASR session started');
            resolve();
            return;
          }
          // Subsequent responses = transcription results
          const result = frame.payload?.result;
          if (result) {
            const utterances = result.utterances || [];
            const isFinal = utterances.some((u: any) => u.definite === true);
            this.opts.onTranscript({
              text: result.text || '',
              isFinal,
            });
          }
        } else if (frame.type === 'error') {
          const msg = frame.payload?.message || frame.payload?.error || 'ASR error';
          this.opts.logger.warn({ payload: frame.payload }, 'Volcengine ASR error frame');
          if (!initResolved) {
            initResolved = true;
            reject(new Error(String(msg)));
          } else {
            this.opts.onError(String(msg));
          }
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        this.opts.logger.error({ err, connectId: this.connectId }, 'Volcengine ASR WebSocket error');
        if (!this.ws) {
          reject(err);
        } else {
          this.opts.onError(err.message);
        }
      });

      ws.on('close', () => {
        this.closed = true;
        this.ws = null;
        this.opts.logger.info({ connectId: this.connectId }, 'Streaming ASR session closed');
        this.opts.onClose();
      });
    });
  }

  /** Send a raw PCM audio chunk (16kHz 16-bit mono) */
  sendAudio(pcmChunk: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.closed) return;
    this.ws.send(packAudioFrame(pcmChunk));
  }

  /** Graceful stop: send empty audio frame to signal end, close after delay */
  stop(): void {
    if (!this.ws || this.closed) return;
    // Empty audio = end of stream
    this.ws.send(packAudioFrame(Buffer.alloc(0)));
    this.closeTimer = setTimeout(() => this.destroy(), GRACEFUL_CLOSE_DELAY_MS);
  }

  /** Force close immediately */
  destroy(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    this.closed = true;
  }

  private sendInitialConfig(): void {
    const config = {
      user: { uid: this.opts.appKey },
      audio: {
        format: 'pcm',
        rate: 16000,
        bits: 16,
        channel: 1,
        codec: 'raw',
      },
      request: {
        model_name: 'bigmodel',
        enable_punc: true,
        enable_itn: true,
        show_utterances: true,
      },
    };
    this.ws!.send(packConfigFrame(config));
  }
}

// ── Factory helpers ──

export function isStreamingASRAvailable(): boolean {
  return !!(process.env.VOLCENGINE_TTS_APPID && process.env.VOLCENGINE_TTS_ACCESS_KEY);
}

export function createStreamingASRSession(
  logger: Logger,
  onTranscript: (event: ASRTranscriptEvent) => void,
  onError: (error: string) => void,
  onClose: () => void,
): StreamingASRSession {
  return new StreamingASRSession({
    appKey: process.env.VOLCENGINE_TTS_APPID!,
    accessKey: process.env.VOLCENGINE_TTS_ACCESS_KEY!,
    logger,
    onTranscript,
    onError,
    onClose,
  });
}
