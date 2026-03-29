import { useState, useRef, useCallback, useEffect } from 'react';
import { useStore } from '../store';
import styles from './VoiceView.module.css';

/* ---- Icons ---- */

function IconMic({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
      <path d="M19 10v2a7 7 0 01-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function IconStop({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function IconPlay({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

/* ---- Types ---- */

type VoiceState = 'idle' | 'recording' | 'processing' | 'playing';

const WAVEFORM_BARS = 24;

/* ---- Component ---- */

export function VoiceView() {
  const activeBotName = useStore((s) => s.activeBotName);
  const token = useStore((s) => s.token);

  const [state, setState] = useState<VoiceState>('idle');
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [sttProvider, setSttProvider] = useState<'doubao' | 'whisper'>('doubao');
  const [ttsProvider, setTtsProvider] = useState<'doubao' | 'openai' | 'elevenlabs'>('doubao');
  const [waveformData, setWaveformData] = useState<number[]>(
    new Array(WAVEFORM_BARS).fill(4),
  );

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number | undefined>(undefined);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  // Waveform animation
  const updateWaveform = useCallback(() => {
    if (!analyzerRef.current) return;
    const analyzer = analyzerRef.current;
    const data = new Uint8Array(analyzer.frequencyBinCount);
    analyzer.getByteFrequencyData(data);

    // Downsample to WAVEFORM_BARS
    const step = Math.floor(data.length / WAVEFORM_BARS);
    const bars: number[] = [];
    for (let i = 0; i < WAVEFORM_BARS; i++) {
      const val = data[i * step] || 0;
      bars.push(Math.max(4, (val / 255) * 40));
    }
    setWaveformData(bars);
    animationRef.current = requestAnimationFrame(updateWaveform);
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Set up analyzer for waveform
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyzer = audioCtx.createAnalyser();
      analyzer.fftSize = 256;
      source.connect(analyzer);
      analyzerRef.current = analyzer;

      // Start MediaRecorder
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
        handleSendAudio(blob);
      };

      mediaRecorder.start();
      mediaRecorderRef.current = mediaRecorder;
      setState('recording');
      setTranscript('');
      setResponse('');
      setAudioUrl(null);

      // Start waveform animation
      updateWaveform();
    } catch (err) {
      console.error('Microphone access denied:', err);
    }
  }, [updateWaveform]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }
    analyzerRef.current = null;
    setWaveformData(new Array(WAVEFORM_BARS).fill(4));
    setState('processing');
  }, []);

  const handleSendAudio = useCallback(
    async (blob: Blob) => {
      setState('processing');

      try {
        const params = new URLSearchParams();
        if (activeBotName) params.set('botName', activeBotName);
        params.set('chatId', `web-voice-${Date.now()}`);
        params.set('stt', sttProvider);
        params.set('tts', ttsProvider);
        params.set('sendCards', 'false');

        const res = await fetch(`/api/voice?${params.toString()}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'audio/webm',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: blob,
        });

        if (!res.ok) {
          const errText = await res.text();
          setResponse(`Error: ${errText}`);
          setState('idle');
          return;
        }

        const contentType = res.headers.get('content-type') || '';

        if (contentType.includes('audio/')) {
          // Response is audio
          const audioBlob = await res.blob();
          const url = URL.createObjectURL(audioBlob);
          setAudioUrl(url);

          // Try to get transcript from header
          const transcriptHeader = res.headers.get('x-transcript');
          if (transcriptHeader) setTranscript(decodeURIComponent(transcriptHeader));

          const responseHeader = res.headers.get('x-response-text');
          if (responseHeader) setResponse(decodeURIComponent(responseHeader));

          // Auto-play
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended = () => setState('idle');
          audio.play();
          setState('playing');
        } else {
          // Response is JSON
          const data = await res.json();
          setTranscript(data.transcript || '');
          setResponse(data.responseText || data.text || JSON.stringify(data));
          setState('idle');
        }
      } catch (err) {
        setResponse(`Failed to process audio: ${err}`);
        setState('idle');
      }
    },
    [activeBotName, sttProvider, ttsProvider, token],
  );

  const handleMicClick = useCallback(() => {
    if (state === 'idle') {
      startRecording();
    } else if (state === 'recording') {
      stopRecording();
    } else if (state === 'playing') {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setState('idle');
    }
  }, [state, startRecording, stopRecording]);

  const playAudio = useCallback(() => {
    if (!audioUrl) return;
    const audio = new Audio(audioUrl);
    audioRef.current = audio;
    audio.onended = () => setState('idle');
    audio.play();
    setState('playing');
  }, [audioUrl]);

  const statusLabels: Record<VoiceState, string> = {
    idle: 'Tap to speak',
    recording: 'Listening...',
    processing: 'Processing...',
    playing: 'Speaking...',
  };

  return (
    <div className={styles.container}>
      {/* Background aura */}
      <div
        className={`${styles.aura} ${
          state !== 'idle' ? styles.auraActive : ''
        } ${
          state === 'recording'
            ? styles.auraRecording
            : state === 'processing'
              ? styles.auraProcessing
              : state === 'playing'
                ? styles.auraPlaying
                : ''
        }`}
      />

      {/* Status */}
      <div
        className={`${styles.statusText} ${
          state === 'recording'
            ? styles.statusRecording
            : state === 'processing'
              ? styles.statusProcessing
              : state === 'playing'
                ? styles.statusPlaying
                : ''
        }`}
      >
        {statusLabels[state]}
      </div>

      {/* Microphone button with rings */}
      <div className={styles.micContainer}>
        <div
          className={`${styles.micRingsOuter} ${
            state === 'recording' ? styles.micRingsOuterActive : ''
          }`}
        />
        <div
          className={`${styles.micRings} ${
            state === 'recording' ? styles.micRingsActive : ''
          }`}
        />
        <button
          className={`${styles.micBtn} ${
            state === 'recording'
              ? styles.micBtnRecording
              : state === 'processing'
                ? styles.micBtnProcessing
                : ''
          } ${state === 'processing' ? styles.micBtnDisabled : ''}`}
          onClick={handleMicClick}
          disabled={state === 'processing'}
        >
          <span
            className={`${styles.micIcon} ${
              state === 'recording'
                ? styles.micIconRecording
                : state === 'processing'
                  ? styles.micIconProcessing
                  : ''
            }`}
          >
            {state === 'recording' ? (
              <IconStop size={24} />
            ) : (
              <IconMic size={28} />
            )}
          </span>
        </button>
      </div>

      {/* Waveform */}
      <div className={styles.waveform}>
        {waveformData.map((h, i) => (
          <div
            key={i}
            className={`${styles.waveBar} ${
              state === 'recording' ? styles.waveBarRecording : ''
            }`}
            style={{ height: `${h}px` }}
          />
        ))}
      </div>

      {/* Transcript */}
      {(transcript || state === 'processing') && (
        <div className={styles.transcript}>
          <div className={styles.transcriptLabel}>You said</div>
          <div
            className={`${styles.transcriptText} ${
              !transcript ? styles.transcriptEmpty : ''
            }`}
          >
            {transcript || (state === 'processing' ? 'Transcribing...' : '')}
          </div>
        </div>
      )}

      {/* Response */}
      {response && (
        <div className={styles.response}>
          <div className={styles.responseLabel}>Response</div>
          <div className={styles.responseText}>{response}</div>

          {audioUrl && state === 'idle' && (
            <div className={styles.audioPlayer}>
              <button className={styles.playBtn} onClick={playAudio}>
                <IconPlay />
              </button>
              <span className={styles.audioLabel}>Play response audio</span>
            </div>
          )}
        </div>
      )}

      {/* Configuration */}
      <div className={styles.config}>
        <div className={styles.configItem}>
          <span>STT:</span>
          <select
            className={styles.configSelect}
            value={sttProvider}
            onChange={(e) => setSttProvider(e.target.value as 'doubao' | 'whisper')}
          >
            <option value="doubao">Doubao</option>
            <option value="whisper">Whisper</option>
          </select>
        </div>
        <div className={styles.configItem}>
          <span>TTS:</span>
          <select
            className={styles.configSelect}
            value={ttsProvider}
            onChange={(e) =>
              setTtsProvider(e.target.value as 'doubao' | 'openai' | 'elevenlabs')
            }
          >
            <option value="doubao">Doubao</option>
            <option value="openai">OpenAI</option>
            <option value="elevenlabs">ElevenLabs</option>
          </select>
        </div>
      </div>

      {/* Instructions */}
      <div className={styles.instructions}>
        Tap the microphone to start recording. Tap again to stop and send your
        voice message to Claude. The response will play automatically.
      </div>
    </div>
  );
}
