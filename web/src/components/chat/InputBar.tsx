/* ---- Input Bar (textarea, file picker, DnD, paste, hold-to-talk STT, send/stop buttons) ---- */

import { useState, useRef, useCallback, useEffect, type KeyboardEvent, type DragEvent, type ClipboardEvent } from 'react';
import type { FileAttachment, WSOutgoingMessage } from '../../types';
import { useStore } from '../../store';
import { fileCategory, formatFileSize } from './helpers';
import { useStreamingASR, isAudioWorkletSupported } from '../../hooks/useStreamingASR';
import { IconSend, IconStop, IconMicSmall, IconPhone, IconPaperclip, IconX, IconKeyboard } from './icons';
import styles from '../ChatView.module.css';

interface PendingFile {
  file: File;
  previewUrl?: string;
}

interface InputBarProps {
  connected: boolean;
  isRunning: boolean;
  onSend: (text: string, files: PendingFile[]) => Promise<void>;
  onStop: () => void;
  onStartCall: () => void;
  callActive: boolean;
  send: (msg: WSOutgoingMessage) => void;
  sendBinary: (data: ArrayBuffer | Uint8Array) => void;
}

type VoiceState = 'idle' | 'recording' | 'recognizing' | 'preview';

export function InputBar({ connected, isRunning, onSend, onStop, onStartCall, callActive, send, sendBinary }: InputBarProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const token = useStore((s) => s.token);

  // ── File upload state ──
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const dragCountRef = useRef(0);

  // ── Hold-to-talk state ──
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [recordDuration, setRecordDuration] = useState(0);
  const [cancelHint, setCancelHint] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [partialText, setPartialText] = useState('');

  // ── Streaming ASR (preferred over HTTP polling) ──
  const [streamingAvailable, setStreamingAvailable] = useState(() => isAudioWorkletSupported());
  const useStreamingRef = useRef(false);
  const { startASR, stopASR, asrState, asrPartialText } = useStreamingASR({ send, sendBinary, connected });

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const touchStartYRef = useRef(0);
  const cancelledRef = useRef(false);
  const durationTimerRef = useRef<ReturnType<typeof setInterval>>();
  const partialTimerRef = useRef<ReturnType<typeof setInterval>>();
  const partialBusyRef = useRef(false);
  const recordingRef = useRef(false); // guard against double-start

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  // Cleanup file preview URLs on unmount
  useEffect(() => {
    return () => {
      pendingFiles.forEach((f) => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Streaming ASR state transitions ──
  useEffect(() => {
    if (!useStreamingRef.current) return;
    if (asrState === 'error') {
      setStreamingAvailable(false);
      if (voiceState === 'recording' || voiceState === 'recognizing') {
        setVoiceState('idle');
      }
      if (durationTimerRef.current) {
        clearInterval(durationTimerRef.current);
        durationTimerRef.current = undefined;
      }
      useStreamingRef.current = false;
      recordingRef.current = false;
      return;
    }
    if (asrState === 'idle' && voiceState === 'recognizing') {
      const text = asrPartialText.trim();
      if (text) {
        setTranscript(text);
        setVoiceState('preview');
      } else {
        setVoiceState('idle');
      }
      useStreamingRef.current = false;
    }
  }, [asrState, voiceState, asrPartialText]);

  // Safety timeout: if streaming recognizing takes too long, use current text
  useEffect(() => {
    if (voiceState !== 'recognizing' || !useStreamingRef.current) return;
    const timer = setTimeout(() => {
      if (!useStreamingRef.current) return;
      const text = asrPartialText.trim();
      if (text) {
        setTranscript(text);
        setVoiceState('preview');
      } else {
        setVoiceState('idle');
      }
      useStreamingRef.current = false;
    }, 3000);
    return () => clearTimeout(timer);
  }, [voiceState, asrPartialText]);

  // ── Partial transcription (called periodically during recording) ──
  const doPartialTranscribe = useCallback(async () => {
    if (partialBusyRef.current || audioChunksRef.current.length === 0) return;
    partialBusyRef.current = true;
    try {
      const blob = new Blob([...audioChunksRef.current], { type: 'audio/webm' });
      const params = new URLSearchParams({ sttOnly: 'true', stt: 'doubao' });
      const res = await fetch(`/api/voice?${params.toString()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'audio/webm',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: blob,
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.transcript) {
          setPartialText(data.transcript);
        }
      }
    } catch {
      // ignore partial errors
    } finally {
      partialBusyRef.current = false;
    }
  }, [token]);

  // ── Final transcription (after recording stops) ──
  const transcribeFinal = useCallback(async (blob: Blob) => {
    setVoiceState('recognizing');
    try {
      const params = new URLSearchParams({ sttOnly: 'true', stt: 'doubao' });
      const res = await fetch(`/api/voice?${params.toString()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'audio/webm',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: blob,
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.transcript) {
          setTranscript(data.transcript);
          setVoiceState('preview');
          return;
        }
      }
      setVoiceState('idle');
    } catch (err) {
      console.error('STT transcription failed:', err);
      setVoiceState('idle');
    }
  }, [token]);

  const startRecording = useCallback(async () => {
    // Guard: prevent double-start
    if (recordingRef.current) return;
    recordingRef.current = true;

    // ── Streaming ASR path (preferred) ──
    if (streamingAvailable) {
      useStreamingRef.current = true;
      cancelledRef.current = false;
      setCancelHint(false);
      setPartialText('');
      setVoiceState('recording');
      setRecordDuration(0);
      const startTime = Date.now();
      durationTimerRef.current = setInterval(() => {
        setRecordDuration(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
      startASR();
      return;
    }

    // ── Fallback: MediaRecorder + HTTP polling ──
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      audioChunksRef.current = [];
      cancelledRef.current = false;
      setCancelHint(false);
      setPartialText('');

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        audioChunksRef.current = [];
        if (!cancelledRef.current && blob.size > 0) {
          transcribeFinal(blob);
        } else {
          setVoiceState('idle');
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250); // chunks every 250ms
      setVoiceState('recording');
      setRecordDuration(0);

      // Duration timer — stable, updates every 1s
      const startTime = Date.now();
      durationTimerRef.current = setInterval(() => {
        setRecordDuration(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);

      // Periodic partial transcription — first at 2s, then every 3s
      partialTimerRef.current = setTimeout(() => {
        doPartialTranscribe();
        partialTimerRef.current = setInterval(() => {
          doPartialTranscribe();
        }, 3000) as unknown as ReturnType<typeof setTimeout>;
      }, 2000) as ReturnType<typeof setTimeout>;
    } catch (err) {
      console.error('Microphone access denied:', err);
      recordingRef.current = false;
    }
  }, [transcribeFinal, doPartialTranscribe, streamingAvailable, startASR]);

  const stopRecording = useCallback((cancelled: boolean) => {
    cancelledRef.current = cancelled;
    recordingRef.current = false;

    // Clear duration timer (common to both paths)
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = undefined;
    }
    setCancelHint(false);

    // ── Streaming ASR path ──
    if (useStreamingRef.current) {
      stopASR();
      if (cancelled) {
        setVoiceState('idle');
        useStreamingRef.current = false;
      } else {
        setVoiceState('recognizing');
        // useEffect handles transition to preview when asrState becomes 'idle'
      }
      return;
    }

    // ── Fallback: MediaRecorder path ──
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    if (partialTimerRef.current) {
      clearInterval(partialTimerRef.current as unknown as ReturnType<typeof setInterval>);
      clearTimeout(partialTimerRef.current);
      partialTimerRef.current = undefined;
    }
    partialBusyRef.current = false;
  }, [stopASR]);

  // ── Preview actions ──
  const handlePreviewSend = useCallback(async () => {
    const text = transcript.trim();
    setTranscript('');
    setPartialText('');
    setVoiceState('idle');
    if (text) {
      await onSend(text, []);
    }
  }, [transcript, onSend]);

  const handlePreviewCancel = useCallback(() => {
    setTranscript('');
    setPartialText('');
    setVoiceState('idle');
  }, []);

  const handlePreviewEdit = useCallback(() => {
    setInput((prev) => prev + transcript);
    setTranscript('');
    setPartialText('');
    setVoiceState('idle');
    setVoiceMode(false);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [transcript]);

  // ── Pointer handlers for hold-to-talk ──
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (voiceState !== 'idle') return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    touchStartYRef.current = e.clientY;
    startRecording();
  }, [voiceState, startRecording]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (voiceState !== 'recording') return;
    const delta = touchStartYRef.current - e.clientY;
    setCancelHint(delta > 80);
    cancelledRef.current = delta > 80;
  }, [voiceState]);

  const handlePointerUp = useCallback(() => {
    if (voiceState !== 'recording') return;
    stopRecording(cancelledRef.current);
  }, [voiceState, stopRecording]);

  // ── Shared file adder ──
  const addFiles = useCallback((fileList: FileList | File[]) => {
    const newFiles: PendingFile[] = [];
    const items = Array.from(fileList);
    for (const file of items) {
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      newFiles.push({ file, previewUrl });
    }
    if (newFiles.length > 0) {
      setPendingFiles((prev) => [...prev, ...newFiles]);
    }
  }, []);

  // ── File input handler ──
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    addFiles(files);
    e.target.value = '';
  }, [addFiles]);

  // ── Drag and drop ──
  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current++;
    if (e.dataTransfer?.types.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current--;
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current = 0;
    setIsDragging(false);
    if (e.dataTransfer?.files.length) {
      addFiles(e.dataTransfer.files);
    }
  }, [addFiles]);

  // ── Paste handler (Ctrl+V images) ──
  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  }, [addFiles]);

  const removeFile = useCallback((index: number) => {
    setPendingFiles((prev) => {
      const next = [...prev];
      if (next[index].previewUrl) URL.revokeObjectURL(next[index].previewUrl!);
      next.splice(index, 1);
      return next;
    });
  }, []);

  // ── Send ──
  const handleSend = useCallback(async () => {
    const text = input.trim();
    const hasFiles = pendingFiles.length > 0;
    if ((!text && !hasFiles) || !connected) return;

    const filesToSend = [...pendingFiles];
    setInput('');
    pendingFiles.forEach((f) => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
    setPendingFiles([]);

    await onSend(text, filesToSend);
  }, [input, connected, pendingFiles, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSend();
      }
      if (e.key === 'Escape' && isRunning) {
        e.preventDefault();
        onStop();
      }
    },
    [handleSend, isRunning, onStop],
  );

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const formatDur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div
      className={`${styles.inputArea} ${isDragging ? styles.inputAreaDragging : ''}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drop zone overlay */}
      {isDragging && (
        <div className={styles.dropOverlay}>
          <IconPaperclip />
          <span>Drop files here</span>
        </div>
      )}
      {/* File preview bar */}
      {pendingFiles.length > 0 && (
        <div className={styles.filePreviews}>
          {pendingFiles.map((f, i) => (
            <div key={i} className={styles.filePreview}>
              {f.previewUrl ? (
                <img src={f.previewUrl} alt={f.file.name} className={styles.filePreviewImg} />
              ) : (
                <div className={styles.filePreviewIcon}>
                  <IconPaperclip />
                </div>
              )}
              <span className={styles.filePreviewName}>{f.file.name}</span>
              <button className={styles.filePreviewRemove} onClick={() => removeFile(i)}>
                <IconX />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Voice overlay — floats above input during recording/recognizing/preview */}
      {voiceState !== 'idle' && voiceMode && (
        <div className={styles.voiceOverlay}>
          {voiceState === 'recording' && (
            <div className={`${styles.voiceRecording} ${cancelHint ? styles.voiceRecordingCancel : ''}`}>
              {(asrPartialText || partialText) && (
                <div className={styles.voicePartialText}>{asrPartialText || partialText}</div>
              )}
              <div className={styles.voiceRecordingBar}>
                <div className={styles.voiceWave}>
                  <span className={styles.voiceWaveBar} />
                  <span className={styles.voiceWaveBar} />
                  <span className={styles.voiceWaveBar} />
                  <span className={styles.voiceWaveBar} />
                  <span className={styles.voiceWaveBar} />
                </div>
                <span className={styles.voiceTimer}>{formatDur(recordDuration)}</span>
                <span className={`${styles.voiceHint} ${cancelHint ? styles.voiceHintCancel : ''}`}>
                  {cancelHint ? '松开取消' : '↑ 上滑取消'}
                </span>
              </div>
            </div>
          )}
          {voiceState === 'recognizing' && (
            <div className={styles.voiceRecognizing}>
              {(asrPartialText || partialText) && (
                <div className={styles.voicePartialText}>{asrPartialText || partialText}</div>
              )}
              <div className={styles.voiceRecognizingBar}>
                <div className={styles.voiceSpinner} />
                <span>识别中...</span>
              </div>
            </div>
          )}
          {voiceState === 'preview' && (
            <div className={styles.voicePreview}>
              <div className={styles.voiceBubble}>{transcript}</div>
              <div className={styles.voiceActions}>
                <button className={styles.voiceActionCancel} onClick={handlePreviewCancel}>取消</button>
                <button className={styles.voiceActionEdit} onClick={handlePreviewEdit}>编辑</button>
                <button className={styles.voiceActionSend} onClick={handlePreviewSend}>
                  <IconSend /> 发送
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className={styles.inputWrapper}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
        <button
          className={styles.attachBtn}
          onClick={() => fileInputRef.current?.click()}
          disabled={!connected}
          title="Upload files"
        >
          <IconPaperclip />
        </button>

        {/* Voice mode: hold-to-talk button */}
        {voiceMode ? (
          <div className={styles.holdToTalk}>
            <button
              className={`${styles.holdToTalkBtn} ${voiceState === 'recording' ? (cancelHint ? styles.holdToTalkBtnCancel : styles.holdToTalkBtnActive) : ''}`}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              disabled={!connected || voiceState === 'recognizing' || voiceState === 'preview'}
            >
              {voiceState === 'recording'
                ? (cancelHint ? '松开 取消' : '松开 转文字')
                : voiceState === 'recognizing'
                  ? '识别中...'
                  : '按住 说话'}
            </button>
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            placeholder={connected ? 'Ask anything...' : 'Connecting...'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
            disabled={!connected}
          />
        )}

        {/* Mode toggle: keyboard ↔ mic */}
        <button
          className={styles.sttBtn}
          onClick={() => { setVoiceMode(!voiceMode); setVoiceState('idle'); setTranscript(''); setPartialText(''); }}
          disabled={!connected || voiceState === 'recording' || voiceState === 'recognizing'}
          title={voiceMode ? 'Switch to keyboard' : 'Switch to voice input'}
        >
          {voiceMode ? <IconKeyboard /> : <IconMicSmall />}
        </button>

        <button
          className={styles.callBtn}
          onClick={onStartCall}
          disabled={!connected || callActive}
          title="Start voice call"
        >
          <IconPhone />
        </button>
        {isRunning ? (
          <button
            className={`${styles.sendBtn} ${styles.stopBtn}`}
            onClick={onStop}
            disabled={!connected}
            title="Stop (Esc)"
          >
            <IconStop />
          </button>
        ) : (
          <button
            className={styles.sendBtn}
            onClick={handleSend}
            disabled={(!input.trim() && pendingFiles.length === 0) || !connected}
            title="Send (Enter)"
          >
            <IconSend />
          </button>
        )}
      </div>

      <div className={styles.inputHint}>
        <span>{voiceMode ? 'Hold the button to record' : 'Enter to send, Shift+Enter for newline'}</span>
        <span>{connected ? '' : 'Reconnecting...'}</span>
      </div>
    </div>
  );
}

export type { PendingFile };
