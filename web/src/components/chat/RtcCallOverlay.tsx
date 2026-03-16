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

export function useRtcCallMode({ activeBotName, token }: RtcCallOverlayProps) {
  const [callActive, setCallActive] = useState(false);
  const [callPhase, setCallPhase] = useState<RtcCallPhase>('connecting');
  const [callStartTime, setCallStartTime] = useState(0);
  const [callElapsed, setCallElapsed] = useState('0:00');
  const [callStatusText, setCallStatusText] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const engineRef = useRef<RtcEngine>(null);
  const sessionInfoRef = useRef<RtcSessionInfo | null>(null);
  const callActiveRef = useRef(false);

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

  /** Start an RTC call */
  const startCall = useCallback(async () => {
    callActiveRef.current = true;
    setCallActive(true);
    setCallPhase('connecting');
    setCallStatusText('Connecting...');
    setErrorMessage('');
    setIsMuted(false);

    try {
      // 1. Load RTC SDK lazily
      const sdk = await loadRtcSdk();
      const VERTC = sdk.default;

      // 2. Call server to create RTC room + AI agent
      const params: Record<string, string> = {};
      if (activeBotName) params.systemPrompt = `You are ${activeBotName}, a helpful AI assistant. Respond in the same language the user speaks. Be concise and conversational.`;
      params.welcomeMessage = '你好，有什么可以帮你的吗？';

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

      // 3. Create RTC engine and join room
      const engine = VERTC.createEngine(info.appId);
      engineRef.current = engine;

      // Listen for remote user events
      engine.on(VERTC.events.onUserJoined, (e: any) => {
        if (e.userInfo?.userId === info.aiUserId) {
          setCallStatusText('AI connected');
        }
      });
      engine.on(VERTC.events.onUserLeave, (e: any) => {
        if (e.userInfo?.userId === info.aiUserId) {
          setCallStatusText('AI disconnected');
        }
      });
      engine.on(VERTC.events.onError, (e: any) => {
        console.error('RTC error:', e);
      });

      // Join the room (audio only)
      await engine.joinRoom(
        info.token,
        info.roomId,
        { userId: info.userId },
        { isAutoPublish: true, isAutoSubscribeAudio: true, isAutoSubscribeVideo: false },
      );

      // Start microphone capture
      await engine.startAudioCapture();

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
  }, [activeBotName, token]);

  /** End the RTC call */
  const endCall = useCallback(async () => {
    callActiveRef.current = false;
    setCallActive(false);
    setCallPhase('ended');
    setCallStatusText('');

    await doCleanup();

    // Tell server to stop the voice chat
    const info = sessionInfoRef.current;
    if (info) {
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
  }, [token]);

  /** Toggle mute */
  const toggleMute = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (isMuted) {
      engine.publishStream(1); // MediaType.AUDIO = 1
      setIsMuted(false);
      setCallStatusText('Unmuted');
    } else {
      engine.unpublishStream(1);
      setIsMuted(true);
      setCallStatusText('Muted');
    }
  }, [isMuted]);

  return {
    callActive, callPhase, callElapsed, callStatusText,
    isMuted, errorMessage,
    startCall, endCall, toggleMute,
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
  onToggleMute: () => void;
  onHangup: () => void;
}

export function RtcCallOverlayUI({
  activeBotName, callElapsed, callPhase, callStatusText,
  isMuted, errorMessage, onToggleMute, onHangup,
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
