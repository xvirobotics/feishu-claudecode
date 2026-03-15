/**
 * TwiML XML template functions for Twilio phone call integration.
 * No Twilio SDK dependency — just string templates.
 */

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Greeting + record the user's command. */
export function greetingAndRecord(recordCallbackUrl: string, language = 'zh-CN'): string {
  const greeting = language.startsWith('zh')
    ? '你好，请说出你的指令。'
    : 'Hello. Please say your command after the beep.';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Say language="${escape(language)}">${escape(greeting)}</Say>`,
    `  <Record action="${escape(recordCallbackUrl)}" maxLength="120" playBeep="true" timeout="3" transcribe="false" />`,
    // Fallback if user doesn't speak — hang up gracefully
    `  <Say language="${escape(language)}">${escape(language.startsWith('zh') ? '没有收到语音输入，再见。' : 'No voice input received. Goodbye.')}</Say>`,
    '</Response>',
  ].join('\n');
}

/** Tell user we're processing, then hang up (async callback will follow). */
export function processingAndHangup(language = 'zh-CN'): string {
  const msg = language.startsWith('zh')
    ? '收到，正在处理中。处理完成后会回拨给你。'
    : 'Got it. Processing your request. I will call you back when done.';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Say language="${escape(language)}">${escape(msg)}</Say>`,
    '</Response>',
  ].join('\n');
}

/** Speak the response text directly (for fast results). */
export function sayResponse(text: string, language = 'zh-CN'): string {
  // Truncate for <Say> — Twilio has a practical limit around 4096 chars
  const truncated = text.length > 2000
    ? text.slice(0, 2000) + (language.startsWith('zh') ? '... 内容过长已截断。' : '... Content truncated.')
    : text;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Say language="${escape(language)}">${escape(truncated)}</Say>`,
    '</Response>',
  ].join('\n');
}

/** Play a pre-generated audio file. */
export function playAudio(audioUrl: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Play>${escape(audioUrl)}</Play>`,
    '</Response>',
  ].join('\n');
}

/** Simple message + hangup (for errors, etc.). */
export function sayAndHangup(text: string, language = 'zh-CN'): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Say language="${escape(language)}">${escape(text)}</Say>`,
    '  <Hangup/>',
    '</Response>',
  ].join('\n');
}

/** Play/say the response, then record again for multi-turn conversation loop. */
export function respondAndContinue(
  audioUrl: string | null,
  responseText: string,
  conversationUrl: string,
  language = 'zh-CN',
): string {
  const truncated = responseText.length > 2000
    ? responseText.slice(0, 2000) + (language.startsWith('zh') ? '... 内容过长已截断。' : '... Content truncated.')
    : responseText;

  const responseVerb = audioUrl
    ? `  <Play>${escape(audioUrl)}</Play>`
    : `  <Say language="${escape(language)}">${escape(truncated)}</Say>`;

  const silenceMsg = language.startsWith('zh')
    ? '没有检测到新的语音输入，通话结束。再见。'
    : 'No voice input detected. Ending the call. Goodbye.';

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    responseVerb,
    `  <Record action="${escape(conversationUrl)}" maxLength="120" playBeep="false" timeout="5" transcribe="false" />`,
    `  <Say language="${escape(language)}">${escape(silenceMsg)}</Say>`,
    '</Response>',
  ].join('\n');
}

/** Greeting + record for multi-turn conversation (outbound calls without a pre-message). */
export function greetingAndContinue(conversationUrl: string, language = 'zh-CN'): string {
  const greeting = language.startsWith('zh')
    ? '你好，我是你的AI助手。请说话。'
    : 'Hello, I am your AI assistant. Please go ahead.';
  const silenceMsg = language.startsWith('zh')
    ? '没有收到语音输入，再见。'
    : 'No voice input. Goodbye.';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Say language="${escape(language)}">${escape(greeting)}</Say>`,
    `  <Record action="${escape(conversationUrl)}" maxLength="120" playBeep="false" timeout="5" transcribe="false" />`,
    `  <Say language="${escape(language)}">${escape(silenceMsg)}</Say>`,
    '</Response>',
  ].join('\n');
}
