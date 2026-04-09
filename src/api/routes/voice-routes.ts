import type * as http from 'node:http';
import { handleVoiceRequest, doubaoTTS, openaiTTS, elevenlabsTTS, edgeTTS, resolveTTSProvider, resolveTTSVoice } from '../voice-handler.js';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';

export async function handleVoiceRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { registry, logger } = ctx;

  // POST /api/voice — STT + Agent + optional TTS
  if (method === 'POST' && (url === '/api/voice' || url.startsWith('/api/voice?'))) {
    await handleVoiceRequest(req, res, registry, logger);
    return true;
  }

  // POST /api/tts — Pure text-to-speech (no STT, no agent)
  if (method === 'POST' && (url === '/api/tts' || url.startsWith('/api/tts?'))) {
    const body = await parseJsonBody(req);
    const text = body.text as string;
    if (!text || typeof text !== 'string' || !text.trim()) {
      jsonResponse(res, 400, { error: 'Missing required field: text' });
      return true;
    }

    const provider = resolveTTSProvider((body.provider as string) || '');
    if (!provider) {
      jsonResponse(res, 400, { error: 'No TTS provider available. Configure VOLCENGINE_TTS_APPID + VOLCENGINE_TTS_ACCESS_KEY, or OPENAI_API_KEY, or ELEVENLABS_API_KEY.' });
      return true;
    }
    const voice = resolveTTSVoice((body.voice as string) || '', provider);

    const maxChars = provider === 'doubao' ? 300 : 4000;
    const ttsText = text.length > maxChars
      ? text.slice(0, maxChars - 10) + '... (truncated)'
      : text;

    let audioBuffer: Buffer;
    if (provider === 'elevenlabs') {
      audioBuffer = await elevenlabsTTS(ttsText, voice);
    } else if (provider === 'doubao') {
      audioBuffer = await doubaoTTS(ttsText, voice);
    } else if (provider === 'edge') {
      audioBuffer = await edgeTTS(ttsText, voice);
    } else {
      audioBuffer = await openaiTTS(ttsText, voice);
    }

    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length.toString(),
      'X-Text-Length': text.length.toString(),
      'X-Provider': provider,
      'X-Voice': voice,
    });
    res.end(audioBuffer);
    return true;
  }

  return false;
}
