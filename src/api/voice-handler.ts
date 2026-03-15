/**
 * Voice handler — STT + Agent + optional TTS.
 *
 * POST /api/voice?botName=xxx&chatId=xxx[&stt=doubao|whisper&tts=doubao|openai|elevenlabs&ttsVoice=...&language=zh]
 * Body: raw audio bytes (m4a, wav, webm, mp3, ogg, etc.)  — max 100 MB
 * Authorization: Bearer <secret>
 *
 * Defaults: stt=doubao, tts=doubao when Volcengine keys are set; falls back to whisper/none otherwise.
 *
 * Response (no tts): JSON { transcript, responseText, success, costUsd, durationMs }
 * Response (tts):    audio/mpeg body, with X-Transcript and X-Response-Text headers (base64).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { Logger } from '../utils/logger.js';
import type { BotRegistry } from './bot-registry.js';

const MAX_AUDIO_SIZE = 100 * 1024 * 1024; // 100 MB (Doubao flash limit)

// ---------------------------------------------------------------------------
// Read raw audio body
// ---------------------------------------------------------------------------

function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_AUDIO_SIZE) {
        req.destroy();
        reject(Object.assign(new Error('Audio too large (max 100 MB)'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Detect audio format from content-type or buffer magic bytes
// ---------------------------------------------------------------------------

function detectAudioExt(contentType: string | undefined, buf: Buffer): string {
  if (contentType?.includes('m4a') || contentType?.includes('mp4')) return 'm4a';
  if (contentType?.includes('wav')) return 'wav';
  if (contentType?.includes('webm')) return 'webm';
  if (contentType?.includes('ogg')) return 'ogg';
  if (contentType?.includes('mp3') || contentType?.includes('mpeg')) return 'mp3';
  // Check magic bytes
  if (buf.length >= 4) {
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'wav';
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
    if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return 'ogg';
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
    if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'm4a';
  }
  return 'm4a'; // default
}

// Map extension to format name for Doubao STT
function extToFormat(ext: string): string {
  const map: Record<string, string> = { m4a: 'mp4', wav: 'wav', mp3: 'mp3', ogg: 'ogg_opus', webm: 'webm' };
  return map[ext] || ext;
}

// ---------------------------------------------------------------------------
// Doubao (Volcengine) STT — Flash Recognition (synchronous)
// ---------------------------------------------------------------------------

async function doubaoTranscribe(audioBuffer: Buffer, ext: string, logger: Logger): Promise<string> {
  const appKey = process.env.VOLCENGINE_TTS_APPID;
  const accessKey = process.env.VOLCENGINE_TTS_ACCESS_KEY;
  if (!appKey || !accessKey) {
    throw Object.assign(new Error('VOLCENGINE_TTS_APPID and VOLCENGINE_TTS_ACCESS_KEY not configured'), { statusCode: 500 });
  }

  const requestId = crypto.randomUUID();
  const url = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-App-Key': appKey,
      'X-Api-Access-Key': accessKey,
      'X-Api-Resource-Id': 'volc.bigasr.auc_turbo',
      'X-Api-Request-Id': requestId,
      'X-Api-Sequence': '-1',
    },
    body: JSON.stringify({
      user: { uid: appKey },
      audio: {
        data: audioBuffer.toString('base64'),
        format: extToFormat(ext),
      },
      request: { model_name: 'bigmodel' },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Doubao STT failed: ${response.status} ${err}`);
  }

  const result = await response.json() as any;
  const text = result?.result?.text || '';
  logger.info({ textLength: text.length, requestId }, 'Doubao STT transcription complete');
  return text;
}

// ---------------------------------------------------------------------------
// Whisper STT
// ---------------------------------------------------------------------------

async function whisperTranscribe(audioBuffer: Buffer, ext: string, language: string, logger: Logger): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw Object.assign(new Error('OPENAI_API_KEY not configured'), { statusCode: 500 });

  const tmpFile = path.join(os.tmpdir(), `voice-${Date.now()}.${ext}`);
  fs.writeFileSync(tmpFile, audioBuffer);

  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey });
    const response = await client.audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(tmpFile),
      language: language === 'auto' ? undefined : language,
    });
    logger.info({ language, textLength: response.text.length }, 'Whisper transcription complete');
    return response.text;
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

// ---------------------------------------------------------------------------
// OpenAI TTS
// ---------------------------------------------------------------------------

async function openaiTTS(text: string, voice: string): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw Object.assign(new Error('OPENAI_API_KEY not configured'), { statusCode: 500 });

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });
  const response = await client.audio.speech.create({
    model: 'tts-1',
    voice: voice as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer',
    input: text,
  });
  return Buffer.from(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// ElevenLabs TTS
// ---------------------------------------------------------------------------

async function elevenlabsTTS(text: string, voiceId: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw Object.assign(new Error('ELEVENLABS_API_KEY not configured'), { statusCode: 500 });

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs TTS failed: ${response.status} ${err}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Doubao (Volcengine) TTS — V3 HTTP Chunked API
// ---------------------------------------------------------------------------

async function doubaoTTS(text: string, speaker: string): Promise<Buffer> {
  const appId = process.env.VOLCENGINE_TTS_APPID;
  const accessKey = process.env.VOLCENGINE_TTS_ACCESS_KEY;
  const resourceId = process.env.VOLCENGINE_TTS_RESOURCE_ID || 'volc.service_type.10029';
  if (!appId || !accessKey) {
    throw Object.assign(new Error('VOLCENGINE_TTS_APPID and VOLCENGINE_TTS_ACCESS_KEY not configured'), { statusCode: 500 });
  }

  const url = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-App-Id': appId,
      'X-Api-Access-Key': accessKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({
      req_params: {
        text,
        speaker,
        audio_params: {
          format: 'mp3',
          sample_rate: 24000,
        },
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Doubao TTS failed: ${response.status} ${err}`);
  }

  // V3 HTTP Chunked returns multiple JSON chunks, each with base64 audio in "data" field
  const body = await response.text();
  const audioChunks: Buffer[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const chunk = JSON.parse(trimmed);
      if (chunk.data) {
        audioChunks.push(Buffer.from(chunk.data, 'base64'));
      }
      if (chunk.code && chunk.code !== 0 && chunk.code !== 20000000) {
        throw new Error(`Doubao TTS error: code=${chunk.code} message=${chunk.message}`);
      }
    } catch (e: any) {
      if (e.message?.startsWith('Doubao TTS error')) throw e;
      // Skip non-JSON lines
    }
  }

  if (audioChunks.length === 0) {
    throw new Error('Doubao TTS returned no audio data');
  }
  return Buffer.concat(audioChunks);
}

// ---------------------------------------------------------------------------
// Resolve defaults: prefer Doubao when keys are configured, fall back to OpenAI
// ---------------------------------------------------------------------------

function resolveSTTProvider(explicit: string): string {
  if (explicit) return explicit;
  // Default to doubao if Volcengine keys exist, otherwise whisper
  if (process.env.VOLCENGINE_TTS_APPID && process.env.VOLCENGINE_TTS_ACCESS_KEY) return 'doubao';
  return 'whisper';
}

function resolveTTSProvider(explicit: string): string {
  if (explicit) return explicit;
  // Default to doubao if Volcengine keys exist, otherwise none (no TTS)
  if (process.env.VOLCENGINE_TTS_APPID && process.env.VOLCENGINE_TTS_ACCESS_KEY) return 'doubao';
  return '';
}

function resolveTTSVoice(explicit: string, ttsProvider: string): string {
  if (explicit) return explicit;
  // Sensible defaults per provider
  if (ttsProvider === 'doubao') return 'zh_female_wanqudashu_moon_bigtts';
  if (ttsProvider === 'elevenlabs') return 'EXAVITQu4vr4xnSDxMaL'; // Bella
  return 'alloy'; // OpenAI
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleVoiceRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  registry: BotRegistry,
  logger: Logger,
): Promise<void> {
  const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const params = parsed.searchParams;

  const botName = params.get('botName') || params.get('bot') || '';
  const chatId = params.get('chatId') || params.get('chat') || 'voice_default';
  const language = params.get('language') || params.get('lang') || 'zh';
  const sttProvider = resolveSTTProvider(params.get('stt') || '');
  const ttsProvider = resolveTTSProvider(params.get('tts') || '');
  const ttsVoice = resolveTTSVoice(params.get('ttsVoice') || params.get('voice') || '', ttsProvider);
  const sendCards = params.get('sendCards') === 'true';

  if (!botName) {
    jsonResponse(res, 400, { error: 'Missing required query param: botName' });
    return;
  }

  const bot = registry.get(botName);
  if (!bot) {
    jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
    return;
  }

  // Read raw audio body
  const audioBuffer = await readRawBody(req);
  if (audioBuffer.length === 0) {
    jsonResponse(res, 400, { error: 'Empty audio body' });
    return;
  }

  const ext = detectAudioExt(req.headers['content-type'], audioBuffer);
  logger.info({ botName, chatId, audioSize: audioBuffer.length, ext, sttProvider, ttsProvider }, 'Voice request received');

  // Step 1: STT
  let transcript: string;
  if (sttProvider === 'whisper') {
    transcript = await whisperTranscribe(audioBuffer, ext, language, logger);
  } else {
    transcript = await doubaoTranscribe(audioBuffer, ext, logger);
  }

  if (!transcript.trim()) {
    jsonResponse(res, 200, { success: true, transcript: '', responseText: '', error: 'No speech detected' });
    return;
  }
  logger.info({ botName, chatId, transcript, sttProvider }, 'Voice transcript');

  // Step 2: Agent execution
  const talkResult = await bot.bridge.executeApiTask({
    prompt: transcript,
    chatId,
    userId: 'voice',
    sendCards,
  });

  const responseText = talkResult.responseText || '';
  logger.info({ botName, chatId, responseLength: responseText.length, costUsd: talkResult.costUsd }, 'Voice response ready');

  // Step 3: Optional TTS
  if (ttsProvider && responseText) {
    try {
      // Truncate very long responses for TTS
      // Doubao V3 limit: 1024 bytes (~300 Chinese chars); OpenAI/ElevenLabs: ~4000 chars
      const maxChars = ttsProvider === 'doubao' ? 300 : 4000;
      const ttsText = responseText.length > maxChars
        ? responseText.slice(0, maxChars - 10) + '... 内容过长，已截断。'
        : responseText;

      let audioOut: Buffer;
      if (ttsProvider === 'elevenlabs') {
        audioOut = await elevenlabsTTS(ttsText, ttsVoice);
      } else if (ttsProvider === 'doubao') {
        audioOut = await doubaoTTS(ttsText, ttsVoice);
      } else {
        audioOut = await openaiTTS(ttsText, ttsVoice);
      }

      // Return audio with metadata in headers
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioOut.length.toString(),
        'X-Transcript': Buffer.from(transcript).toString('base64'),
        'X-Response-Text': Buffer.from(responseText.slice(0, 2000)).toString('base64'),
        'X-Cost-Usd': (talkResult.costUsd || 0).toString(),
      });
      res.end(audioOut);
      return;
    } catch (ttsErr: any) {
      logger.error({ err: ttsErr, ttsProvider }, 'TTS failed, falling back to JSON response');
      // Fall through to JSON response
    }
  }

  // Return JSON (no TTS or TTS failed)
  jsonResponse(res, 200, {
    success: talkResult.success,
    transcript,
    responseText,
    costUsd: talkResult.costUsd,
    durationMs: talkResult.durationMs,
  });
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}
