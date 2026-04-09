/* ---- Phone Call Overlay ---- */

import { useState, useRef, useCallback, useEffect } from 'react';
import type { FileAttachment } from '../../types';
import { useStore } from '../../store';
import { generateId, decodeBase64Utf8 } from './helpers';
import { IconMic, IconPhoneOff } from './icons';
import styles from '../ChatView.module.css';

type CallPhase = 'recording' | 'processing' | 'playing';

interface CallOverlayProps {
  activeBotName: string | null;
  activeSessionId: string | null;
  token: string | null;
  onEnsureSession: () => string;
  autoScrollRef: React.MutableRefObject<boolean>;
}

export function useCallMode({ activeBotName, activeSessionId, token, onEnsureSession, autoScrollRef }: CallOverlayProps) {
  const addMessage = useStore((s) => s.addMessage);
  const updateMessageText = useStore((s) => s.updateMessageText);
  const updateMessageState = useStore((s) => s.updateMessageState);

  const [callActive, setCallActive] = useState(false);
  const [callPhase, setCallPhase] = useState<CallPhase>('recording');
  const [callStartTime, setCallStartTime] = useState(0);
  const [callElapsed, setCallElapsed] = useState('0:00');
  const [callStatusText, setCallStatusText] = useState('');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const playbackSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const callActiveRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vadRafRef = useRef<number>(0);
  const hasSpokenRef = useRef(false);
  const handleCallVoiceSendRef = useRef<(blob: Blob) => void>(() => {});

  // Call duration timer
  useEffect(() => {
    if (!callActive) return;
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      setCallElapsed(`${m}:${s.toString().padStart(2, '0')}`);
    }, 1000);
    return () => clearInterval(interval);
  }, [callActive, callStartTime]);

  // Stop VAD monitoring
  const stopVAD = useCallback(() => {
    if (vadRafRef.current) { cancelAnimationFrame(vadRafRef.current); vadRafRef.current = 0; }
    if (vadTimerRef.current) { clearTimeout(vadTimerRef.current); vadTimerRef.current = null; }
    if (audioContextRef.current) { audioContextRef.current.close().catch(() => {}); audioContextRef.current = null; }
    analyserRef.current = null;
    hasSpokenRef.current = false;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (audioRef.current) {
        audioRef.current.pause();
      }
      stopVAD();
    };
  }, [stopVAD]);

  // Start recording within an active call (with VAD)
  const startCallRecording = useCallback(async () => {
    if (!callActiveRef.current) return;
    setCallPhase('recording');
    setCallStatusText('Listening...');
    stopVAD();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!callActiveRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });
      chunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        if (blob.size > 0) handleCallVoiceSendRef.current(blob);
      };
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();

      // Set up VAD
      const audioCtx = new AudioContext();
      audioContextRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      analyserRef.current = analyser;
      hasSpokenRef.current = false;

      const SPEECH_THRESHOLD = 3;
      const SILENCE_DURATION = 1800;
      const dataArray = new Uint8Array(analyser.fftSize);

      const checkAudio = () => {
        if (!callActiveRef.current || mediaRecorderRef.current?.state !== 'recording') return;
        analyser.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const val = (dataArray[i] - 128) / 128;
          sum += val * val;
        }
        const rms = Math.sqrt(sum / dataArray.length) * 100;

        if (rms > SPEECH_THRESHOLD) {
          if (!hasSpokenRef.current) {
            hasSpokenRef.current = true;
            setCallStatusText('Speaking...');
          }
          if (vadTimerRef.current) { clearTimeout(vadTimerRef.current); vadTimerRef.current = null; }
        } else if (hasSpokenRef.current && !vadTimerRef.current) {
          vadTimerRef.current = setTimeout(() => {
            if (callActiveRef.current && mediaRecorderRef.current?.state === 'recording') {
              mediaRecorderRef.current.stop();
              if (streamRef.current) {
                streamRef.current.getTracks().forEach((t) => t.stop());
                streamRef.current = null;
              }
              stopVAD();
            }
          }, SILENCE_DURATION);
        }

        vadRafRef.current = requestAnimationFrame(checkAudio);
      };
      vadRafRef.current = requestAnimationFrame(checkAudio);
    } catch {
      setCallStatusText('Microphone access denied');
    }
  }, [stopVAD]);

  // Stop recording
  const stopCallRecording = useCallback(() => {
    stopVAD();
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, [stopVAD]);

  // Process and send recorded audio
  const handleCallVoiceSend = useCallback(
    async (blob: Blob) => {
      if (!callActiveRef.current) return;
      setCallPhase('processing');
      setCallStatusText('Thinking...');

      const sessionId = activeSessionId || onEnsureSession();
      const userMsgId = generateId();
      const assistantMsgId = generateId();

      addMessage(sessionId, { id: userMsgId, type: 'user', text: 'Voice message...', timestamp: Date.now() });
      addMessage(sessionId, {
        id: assistantMsgId, type: 'assistant', text: '',
        state: { status: 'thinking', userPrompt: 'Voice message', responseText: '', toolCalls: [] },
        timestamp: Date.now(),
      });
      autoScrollRef.current = true;

      try {
        const params = new URLSearchParams();
        if (activeBotName) params.set('botName', activeBotName);
        params.set('chatId', sessionId);
        params.set('tts', 'doubao');
        params.set('voiceMode', 'true');
        params.set('sendCards', 'false');

        const res = await fetch(`/api/voice?${params.toString()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'audio/webm', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: blob,
        });

        if (!res.ok) {
          const errText = await res.text();
          updateMessageText(sessionId, userMsgId, 'Voice (failed)');
          updateMessageState(sessionId, assistantMsgId, {
            status: 'error', userPrompt: '', responseText: '', toolCalls: [], errorMessage: errText,
          });
          if (callActiveRef.current) startCallRecording();
          return;
        }

        const ct = res.headers.get('content-type') || '';

        if (ct.includes('audio/')) {
          const audioBlob = await res.blob();
          const th = res.headers.get('x-transcript');
          const rh = res.headers.get('x-response-text');
          const transcript = th ? decodeBase64Utf8(th) : 'Voice message';
          const responseText = rh ? decodeBase64Utf8(rh) : '';

          updateMessageText(sessionId, userMsgId, transcript);
          updateMessageState(sessionId, assistantMsgId, {
            status: 'complete', userPrompt: transcript, responseText, toolCalls: [],
          });

          setCallPhase('playing');
          setCallStatusText('Speaking...');
          const arrayBuf = await audioBlob.arrayBuffer();
          const pCtx = playbackCtxRef.current;
          if (pCtx && pCtx.state !== 'closed') {
            try {
              if (pCtx.state === 'suspended') await pCtx.resume();
              const audioBuf = await pCtx.decodeAudioData(arrayBuf);
              const source = pCtx.createBufferSource();
              source.buffer = audioBuf;
              source.connect(pCtx.destination);
              playbackSourceRef.current = source;
              source.onended = () => {
                playbackSourceRef.current = null;
                if (callActiveRef.current) startCallRecording();
              };
              source.start();
            } catch {
              const url = URL.createObjectURL(audioBlob);
              const audio = new Audio(url);
              audioRef.current = audio;
              audio.onended = () => { URL.revokeObjectURL(url); if (callActiveRef.current) startCallRecording(); };
              audio.play().catch(() => { if (callActiveRef.current) startCallRecording(); });
            }
          } else {
            if (callActiveRef.current) startCallRecording();
          }
        } else {
          const data = await res.json();
          updateMessageText(sessionId, userMsgId, data.transcript || 'Voice message');
          updateMessageState(sessionId, assistantMsgId, {
            status: 'complete', userPrompt: data.transcript || '', responseText: data.responseText || '', toolCalls: [],
          });
          if (callActiveRef.current) startCallRecording();
        }
      } catch (err) {
        updateMessageText(sessionId, userMsgId, 'Voice (error)');
        updateMessageState(sessionId, assistantMsgId, {
          status: 'error', userPrompt: '', responseText: '', toolCalls: [],
          errorMessage: `${err}`,
        });
        if (callActiveRef.current) startCallRecording();
      }
    },
    [activeSessionId, activeBotName, onEnsureSession, addMessage, updateMessageState, updateMessageText, token, startCallRecording, autoScrollRef],
  );

  // Keep ref in sync
  useEffect(() => {
    handleCallVoiceSendRef.current = handleCallVoiceSend;
  }, [handleCallVoiceSend]);

  // Start a call
  const startCall = useCallback(async () => {
    if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
      playbackCtxRef.current = new AudioContext();
    }
    if (playbackCtxRef.current.state === 'suspended') {
      await playbackCtxRef.current.resume();
    }
    callActiveRef.current = true;
    setCallActive(true);
    setCallStartTime(Date.now());
    setCallElapsed('0:00');
    startCallRecording();
  }, [startCallRecording]);

  // End the call
  const endCall = useCallback(() => {
    callActiveRef.current = false;
    setCallActive(false);
    setCallStatusText('');
    stopVAD();
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      if (audioRef.current.src?.startsWith('blob:')) URL.revokeObjectURL(audioRef.current.src);
      audioRef.current = null;
    }
    if (playbackSourceRef.current) {
      try { playbackSourceRef.current.stop(); } catch { /* ignore */ }
      playbackSourceRef.current = null;
    }
    if (playbackCtxRef.current) {
      playbackCtxRef.current.close().catch(() => {});
      playbackCtxRef.current = null;
    }
  }, [stopVAD]);

  // Tap center button during call
  const handleCallTap = useCallback(() => {
    if (callPhase === 'recording') {
      stopCallRecording();
    } else if (callPhase === 'playing') {
      if (playbackSourceRef.current) {
        try { playbackSourceRef.current.stop(); } catch { /* ignore */ }
        playbackSourceRef.current = null;
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      startCallRecording();
    }
  }, [callPhase, stopCallRecording, startCallRecording]);

  return {
    callActive, callPhase, callElapsed, callStatusText,
    startCall, endCall, handleCallTap,
  };
}

/* ---- Call Overlay UI ---- */

interface CallOverlayUIProps {
  activeBotName: string | null;
  callElapsed: string;
  callPhase: CallPhase;
  callStatusText: string;
  onTap: () => void;
  onHangup: () => void;
}

export function CallOverlayUI({ activeBotName, callElapsed, callPhase, callStatusText, onTap, onHangup }: CallOverlayUIProps) {
  return (
    <div className={styles.callOverlay}>
      <div className={styles.callContent}>
        <div className={styles.callHeader}>
          <div className={styles.callBotName}>{activeBotName || 'Claude'}</div>
          <div className={styles.callTimer}>{callElapsed}</div>
        </div>

        <button
          className={`${styles.callCenterBtn} ${
            callPhase === 'recording' ? styles.callCenterRecording : ''
          } ${callPhase === 'processing' ? styles.callCenterProcessing : ''} ${
            callPhase === 'playing' ? styles.callCenterPlaying : ''
          }`}
          onClick={onTap}
          disabled={callPhase === 'processing'}
        >
          <IconMic />
        </button>

        <div className={styles.callStatus}>{callStatusText}</div>

        <button className={styles.callHangup} onClick={onHangup} title="End call">
          <IconPhoneOff />
        </button>
      </div>
    </div>
  );
}
