/* ---- Input Bar (textarea, file picker, DnD, paste, STT, send/stop buttons) ---- */

import { useState, useRef, useCallback, useEffect, type KeyboardEvent, type DragEvent, type ClipboardEvent } from 'react';
import type { FileAttachment } from '../../types';
import { fileCategory, formatFileSize } from './helpers';
import { IconSend, IconStop, IconMicSmall, IconPhone, IconPaperclip, IconX } from './icons';
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
}

export function InputBar({ connected, isRunning, onSend, onStop, onStartCall, callActive }: InputBarProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Speech-to-text state ──
  const [sttActive, setSttActive] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sttRef = useRef<any>(null);

  // ── File upload state ──
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const dragCountRef = useRef(0);

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

  // ── STT ──
  const startSTT = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this browser.');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;

    let finalTranscript = '';
    const baseInput = input;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += t;
        } else {
          interim += t;
        }
      }
      setInput(baseInput + finalTranscript + interim);
    };

    recognition.onerror = () => {
      setSttActive(false);
      sttRef.current = null;
    };

    recognition.onend = () => {
      setSttActive(false);
      sttRef.current = null;
    };

    sttRef.current = recognition;
    recognition.start();
    setSttActive(true);
  }, [input]);

  const stopSTT = useCallback(() => {
    if (sttRef.current) {
      sttRef.current.stop();
      sttRef.current = null;
    }
    setSttActive(false);
  }, []);

  const toggleSTT = useCallback(() => {
    if (sttActive) stopSTT();
    else startSTT();
  }, [sttActive, startSTT, stopSTT]);

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

    if (sttActive) stopSTT();

    const filesToSend = [...pendingFiles];
    setInput('');
    pendingFiles.forEach((f) => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
    setPendingFiles([]);

    await onSend(text, filesToSend);
  }, [input, connected, pendingFiles, sttActive, stopSTT, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
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

  // Expose focus method via ref effect
  useEffect(() => {
    // Auto-focus textarea on mount
    textareaRef.current?.focus();
  }, []);

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
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          placeholder={connected ? (sttActive ? 'Listening...' : 'Ask anything...') : 'Connecting...'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={1}
          disabled={!connected}
        />
        <button
          className={`${styles.sttBtn} ${sttActive ? styles.sttBtnActive : ''}`}
          onClick={toggleSTT}
          disabled={!connected}
          title={sttActive ? 'Stop voice input' : 'Voice input'}
        >
          <IconMicSmall />
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
        <span>Enter to send, Shift+Enter for newline</span>
        <span>{connected ? '' : 'Reconnecting...'}</span>
      </div>
    </div>
  );
}

export type { PendingFile };
