/**
 * useStreamingASR — AudioWorklet-based PCM capture + WebSocket streaming ASR.
 *
 * Captures mic audio, downsamples to 16kHz 16-bit mono via AudioWorklet,
 * sends binary PCM frames through the existing /ws WebSocket, and receives
 * real-time transcripts from the server (which proxies to Volcengine).
 */

import { useRef, useCallback, useEffect } from 'react';
import { useStore } from '../store';
import type { WSOutgoingMessage } from '../types';

interface StreamingASRDeps {
  send: (msg: WSOutgoingMessage) => void;
  sendBinary: (data: ArrayBuffer | Uint8Array) => void;
  connected: boolean;
}

export function useStreamingASR({ send, sendBinary, connected }: StreamingASRDeps) {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const activeRef = useRef(false);

  const asrState = useStore((s) => s.asrState);
  const asrPartialText = useStore((s) => s.asrPartialText);
  const setAsrState = useStore((s) => s.setAsrState);
  const setAsrPartialText = useStore((s) => s.setAsrPartialText);

  const cleanup = useCallback(() => {
    if (workletRef.current) {
      workletRef.current.disconnect();
      workletRef.current.port.onmessage = null;
      workletRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const startASR = useCallback(async () => {
    if (activeRef.current || !connected) return;
    activeRef.current = true;
    setAsrState('connecting');
    setAsrPartialText('');

    try {
      // 1. Acquire microphone
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      // 2. Create AudioContext (use browser's native rate; worklet handles downsampling)
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;

      // Ensure context is running (mobile browsers may suspend)
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      // 3. Load AudioWorklet processor
      const workletUrl = new URL('/web/pcm-processor.js', location.origin).href;
      await audioCtx.audioWorklet.addModule(workletUrl);

      // 4. Wire: mic → worklet → binary WS
      const source = audioCtx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');
      workletRef.current = workletNode;

      workletNode.port.onmessage = (event) => {
        if (event.data?.type === 'pcm' && activeRef.current) {
          sendBinary(event.data.samples);
        }
      };

      source.connect(workletNode);
      // No need to connect to destination — we just capture, don't play back

      // 5. Tell server to start Volcengine ASR session
      send({ type: 'start_asr' });
    } catch (err) {
      console.error('Failed to start streaming ASR:', err);
      setAsrState('error');
      activeRef.current = false;
      cleanup();
    }
  }, [connected, send, sendBinary, setAsrState, setAsrPartialText, cleanup]);

  const stopASR = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    send({ type: 'stop_asr' });
    cleanup();
  }, [send, cleanup]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (activeRef.current) {
        activeRef.current = false;
        send({ type: 'stop_asr' });
        cleanup();
      }
    };
  }, [send, cleanup]);

  return {
    startASR,
    stopASR,
    asrState,
    asrPartialText,
  };
}

/** Check if AudioWorklet is supported (for fallback detection) */
export function isAudioWorkletSupported(): boolean {
  return typeof window !== 'undefined' && 'AudioWorkletNode' in window;
}
