/* ---- RTC Phone Call Overlay ---- */
/* Uses Volcengine RTC for real-time voice with Doubao AI (ASR → LLM → TTS in cloud) */
/* The @volcengine/rtc SDK is dynamically imported to avoid bloating the main bundle */

import { useState, useRef, useCallback, useEffect } from 'react';
import { IconMic, IconPhoneOff } from './icons';
import styles from '../ChatView.module.css';

type RtcCallPhase = 'connecting' | 'connected' | 'ended' | 'error';

interface RtcCallOverlayProps {
  activeBotName: string | null;
  activeSessionId: string | null;
  token: string | null;
  /** Called with formatted transcript text when a call ends (for injecting into chat) */
  onTranscript?: (text: string) => void;
}

interface RtcSessionInfo {
  sessionId: string;
  roomId: string;
  taskId: string;
  token: string;
  appId: string;
  userId: string;
  aiUserId: string;
}

interface TranscriptEntry {
  speaker: 'user' | 'ai';
  text: string;
  timestamp: number;
}

/** Incoming call info pushed from server via WebSocket */
export interface IncomingVoiceCall {
  sessionId: string;
  roomId: string;
  token: string;
  appId: string;
  userId: string;
  aiUserId: string;
  chatId: string;
  botName: string;
  prompt?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RtcEngine = any;

// Lazily loaded RTC SDK module
let rtcModule: typeof import('@volcengine/rtc') | null = null;

async function loadRtcSdk() {
  if (!rtcModule) {
    rtcModule = await import('@volcengine/rtc');
  }
  return rtcModule;
}

/* ---- TLV Binary Parser for RTC AIGC subtitle messages ---- */

interface SubtitleData {
  type: string;
  data: Array<{
    text: string;
    userId: string;
    sequence: number;
    definite: boolean;
    paragraph: boolean;
    roundId?: number;
    language?: string;
  }>;
}

function parseTlv(buffer: ArrayBuffer): { magic: string; payload: string } | null {
  if (buffer.byteLength < 8) return null;
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  );
  const length = view.getUint32(4, false); // big-endian
  if (buffer.byteLength < 8 + length) return null;
  const payload = new TextDecoder().decode(new Uint8Array(buffer, 8, length));
  return { magic, payload };
}

function parseSubtitle(buffer: ArrayBuffer): SubtitleData | null {
  const tlv = parseTlv(buffer);
  if (!tlv || tlv.magic !== 'subv') return null;
  try {
    return JSON.parse(tlv.payload);
  } catch {
    return null;
  }
}

/* ---- Hook ---- */

export function useRtcCallMode({ activeBotName, activeSessionId, token, onTranscript }: RtcCallOverlayProps) {
  const [callActive, setCallActive] = useState(false);
  const [callPhase, setCallPhase] = useState<RtcCallPhase>('connecting');
  const [callStartTime, setCallStartTime] = useState(0);
  const [callElapsed, setCallElapsed] = useState('0:00');
  const [callStatusText, setCallStatusText] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [subtitleText, setSubtitleText] = useState('');

  const engineRef = useRef<RtcEngine>(null);
  const sessionInfoRef = useRef<RtcSessionInfo | null>(null);
  const callActiveRef = useRef(false);
  const transcriptRef = useRef<TranscriptEntry[]>([]);

  // Call duration timer
  useEffect(() => {
    if (!callActive || callPhase !== 'connected') return;
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      setCallElapsed(`${m}:${s.toString().padStart(2, '0')}`);
    }, 1000);
    return () => clearInterval(interval);
  }, [callActive, callStartTime, callPhase]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (callActiveRef.current) {
        doCleanup();
      }
    };
  }, []);

  async function doCleanup() {
    const engine = engineRef.current;
    if (engine) {
      try {
        engine.stopAudioCapture();
        engine.leaveRoom();
      } catch { /* ignore */ }
      const sdk = await loadRtcSdk();
      sdk.default.destroyEngine(engine);
      engineRef.current = null;
    }
  }

  /** Submit collected transcript to server and notify parent for chat injection */
  async function submitTranscript(info: RtcSessionInfo) {
    const transcript = transcriptRef.current;
    if (transcript.length === 0) return;

    // Format transcript text for chat display
    const transcriptText = transcript
      .map((e) => `[${e.speaker === 'ai' ? 'AI' : 'User'}]: ${e.text}`)
      .join('\n');

    // Notify parent to send as chat message (this triggers Claude processing via WebSocket)
    if (onTranscript && transcriptText) {
      const chatMsg = `[语音通话记录]\n\n${transcriptText}\n\n请根据以上语音对话内容，判断是否有需要执行的后续任务。如果对话中提到了具体的工作请求，请直接执行。如果只是闲聊，简单确认即可。`;
      onTranscript(chatMsg);
    }

    // Also store on server (for API access / long-poll)
    try {
      await fetch('/api/rtc/transcript', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          sessionId: info.sessionId,
          transcript,
        }),
      });
    } catch (err) {
      console.error('Failed to submit transcript:', err);
    }
  }

  /** Set up TLV subtitle listener on the RTC engine */
  function setupSubtitleListener(engine: RtcEngine, aiUserId: string, VERTC: any) {
    engine.on(VERTC.events.onRoomBinaryMessageReceived, (event: { userId: string; message: ArrayBuffer }) => {
      const subtitle = parseSubtitle(event.message);
      if (!subtitle || subtitle.type !== 'subtitle') return;

      for (const entry of subtitle.data) {
        // Show live subtitle
        if (entry.text) {
          setSubtitleText(entry.text);
        }
        // Only collect complete sentences into transcript
        if (entry.paragraph && entry.definite && entry.text.trim()) {
          transcriptRef.current.push({
            speaker: entry.userId === aiUserId ? 'ai' : 'user',
            text: entry.text.trim(),
            timestamp: Date.now(),
          });
        }
      }
    });
  }

  /** Join an existing RTC room (for incoming calls from agent) */
  const joinCall = useCallback(async (incoming: IncomingVoiceCall) => {
    callActiveRef.current = true;
    setCallActive(true);
    setCallPhase('connecting');
    setCallStatusText('Joining call...');
    setErrorMessage('');
    setIsMuted(false);
    setSubtitleText('');
    transcriptRef.current = [];

    try {
      const sdk = await loadRtcSdk();
      const VERTC = sdk.default;

      const info: RtcSessionInfo = {
        sessionId: incoming.sessionId,
        roomId: incoming.roomId,
        taskId: '',
        token: incoming.token,
        appId: incoming.appId,
        userId: incoming.userId,
        aiUserId: incoming.aiUserId,
      };
      sessionInfoRef.current = info;

      const engine = VERTC.createEngine(info.appId);
      engineRef.current = engine;

      engine.on(VERTC.events.onUserJoined, (e: any) => {
        if (e.userInfo?.userId === info.aiUserId) setCallStatusText('AI connected');
      });
      engine.on(VERTC.events.onUserLeave, (e: any) => {
        if (e.userInfo?.userId === info.aiUserId) setCallStatusText('AI disconnected');
      });
      engine.on(VERTC.events.onError, (e: any) => console.error('RTC error:', e));

      // Set up subtitle/transcript collection
      setupSubtitleListener(engine, info.aiUserId, VERTC);

      await engine.joinRoom(
        info.token, info.roomId,
        {
          userId: info.userId,
          extraInfo: JSON.stringify({ call_scene: 'RTC-AIGC', user_name: info.userId, user_id: info.userId }),
        },
        {
          isAutoPublish: true,
          isAutoSubscribeAudio: true,
          isAutoSubscribeVideo: false,
          roomProfileType: VERTC.RoomProfileType?.chat ?? 0,
        },
      );
      await engine.startAudioCapture();
      // Explicitly publish audio as belt-and-suspenders (official demo does this)
      await engine.publishStream(VERTC.MediaType?.AUDIO ?? 1);

      setCallPhase('connected');
      setCallStartTime(Date.now());
      setCallElapsed('0:00');
      setCallStatusText('Connected');
    } catch (err: any) {
      console.error('RTC join failed:', err);
      setCallPhase('error');
      setErrorMessage(err.message || 'Failed to join call');
      setCallStatusText('Error');
      await doCleanup();
    }
  }, [token]);

  /** Start an RTC call (user-initiated) */
  const startCall = useCallback(async () => {
    callActiveRef.current = true;
    setCallActive(true);
    setCallPhase('connecting');
    setCallStatusText('Connecting...');
    setErrorMessage('');
    setIsMuted(false);
    setSubtitleText('');
    transcriptRef.current = [];

    try {
      const sdk = await loadRtcSdk();
      const VERTC = sdk.default;

      // Call server to create RTC room + AI agent
      // System prompt is built server-side from botName; only pass if custom
      const params: Record<string, string> = {};
      params.welcomeMessage = '你好，有什么可以帮你的吗？';
      if (activeSessionId) params.chatId = activeSessionId;
      if (activeBotName) params.botName = activeBotName;

      const res = await fetch('/api/rtc/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(params),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Server returned ${res.status}`);
      }

      const info: RtcSessionInfo = await res.json();
      sessionInfoRef.current = info;

      const engine = VERTC.createEngine(info.appId);
      engineRef.current = engine;

      engine.on(VERTC.events.onUserJoined, (e: any) => {
        if (e.userInfo?.userId === info.aiUserId) setCallStatusText('AI connected');
      });
      engine.on(VERTC.events.onUserLeave, (e: any) => {
        if (e.userInfo?.userId === info.aiUserId) setCallStatusText('AI disconnected');
      });
      engine.on(VERTC.events.onError, (e: any) => console.error('RTC error:', e));

      // Set up subtitle/transcript collection
      setupSubtitleListener(engine, info.aiUserId, VERTC);

      await engine.joinRoom(
        info.token, info.roomId,
        {
          userId: info.userId,
          extraInfo: JSON.stringify({ call_scene: 'RTC-AIGC', user_name: info.userId, user_id: info.userId }),
        },
        {
          isAutoPublish: true,
          isAutoSubscribeAudio: true,
          isAutoSubscribeVideo: false,
          roomProfileType: VERTC.RoomProfileType?.chat ?? 0,
        },
      );
      await engine.startAudioCapture();
      // Explicitly publish audio as belt-and-suspenders (official demo does this)
      await engine.publishStream(VERTC.MediaType?.AUDIO ?? 1);

      setCallPhase('connected');
      setCallStartTime(Date.now());
      setCallElapsed('0:00');
      setCallStatusText('Connected');
    } catch (err: any) {
      console.error('RTC call failed:', err);
      setCallPhase('error');
      setErrorMessage(err.message || 'Failed to start call');
      setCallStatusText('Error');
      await doCleanup();
    }
  }, [activeBotName, activeSessionId, token]);

  /** End the RTC call */
  const endCall = useCallback(async () => {
    callActiveRef.current = false;
    setCallActive(false);
    setCallPhase('ended');
    setCallStatusText('');
    setSubtitleText('');

    const info = sessionInfoRef.current;

    await doCleanup();

    // Submit transcript + stop session
    if (info) {
      await submitTranscript(info);
      try {
        await fetch('/api/rtc/stop', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ sessionId: info.sessionId }),
        });
      } catch { /* ignore */ }
      sessionInfoRef.current = null;
    }
    transcriptRef.current = [];
  }, [token]);

  /** Toggle mute */
  const toggleMute = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      if (isMuted) {
        await engine.startAudioCapture();
        setIsMuted(false);
        setCallStatusText('Unmuted');
      } else {
        await engine.stopAudioCapture();
        setIsMuted(true);
        setCallStatusText('Muted');
      }
    } catch (err) {
      console.error('Toggle mute failed:', err);
    }
  }, [isMuted]);

  return {
    callActive, callPhase, callElapsed, callStatusText,
    isMuted, errorMessage, subtitleText,
    startCall, endCall, toggleMute, joinCall,
  };
}

/* ---- RTC Call Overlay UI ---- */

interface RtcCallOverlayUIProps {
  activeBotName: string | null;
  callElapsed: string;
  callPhase: RtcCallPhase;
  callStatusText: string;
  isMuted: boolean;
  errorMessage: string;
  subtitleText?: string;
  onToggleMute: () => void;
  onHangup: () => void;
}

export function RtcCallOverlayUI({
  activeBotName, callElapsed, callPhase, callStatusText,
  isMuted, errorMessage, subtitleText, onToggleMute, onHangup,
}: RtcCallOverlayUIProps) {
  return (
    <div className={styles.callOverlay}>
      <div className={styles.callContent}>
        <div className={styles.callHeader}>
          <div className={styles.callBotName}>{activeBotName || 'Doubao AI'}</div>
          <div className={styles.callTimer}>
            {callPhase === 'connecting' ? 'Connecting...' : callElapsed}
          </div>
          <div className={styles.callRtcBadge}>RTC</div>
        </div>

        <button
          className={`${styles.callCenterBtn} ${
            isMuted ? styles.callCenterProcessing : styles.callCenterRecording
          }`}
          onClick={onToggleMute}
          disabled={callPhase !== 'connected'}
        >
          <IconMic />
        </button>

        {/* Live subtitle display */}
        {subtitleText && callPhase === 'connected' && (
          <div className={styles.callSubtitle}>{subtitleText}</div>
        )}

        <div className={styles.callStatus}>
          {errorMessage || callStatusText}
        </div>

        <button className={styles.callHangup} onClick={onHangup} title="End call">
          <IconPhoneOff />
        </button>
      </div>
    </div>
  );
}
