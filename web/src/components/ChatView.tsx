/* ============================================================
   MetaBot Web — ChatView (orchestrator)

   Sub-components live in ./chat/:
     MessageList, InputBar, CallOverlay, FilePanel,
     AssistantMessage, FilePreviewContent, EmptyState, etc.
   ============================================================ */

import { useRef, useCallback, useMemo, useState, useEffect } from 'react';
import { useStore } from '../store';
import { useWebSocket } from '../hooks/useWebSocket';
import type { CardState, FileAttachment } from '../types';
import {
  MessageList,
  InputBar,
  type PendingFile,
  CallOverlayUI,
  useCallMode,
  RtcCallOverlayUI,
  useRtcCallMode,
  useFilePanel,
  FilePanelToggle,
  FilePanelContent,
  MobileFileOverlay,
  EmptyState,
  generateId,
  fileCategory,
  formatFileSize,
  type IncomingVoiceCall,
} from './chat';
import styles from './ChatView.module.css';

/* ── Mobile detection hook ── */
function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [breakpoint]);
  return isMobile;
}

export function ChatView() {
  const activeSessionId = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);
  const addMessage = useStore((s) => s.addMessage);
  const createSession = useStore((s) => s.createSession);
  const connected = useStore((s) => s.connected);
  const activeBotName = useStore((s) => s.activeBotName);
  const bots = useStore((s) => s.bots);
  const token = useStore((s) => s.token);

  const activeBot = bots.find((b) => b.name === activeBotName);

  const { send, sendBinary } = useWebSocket();

  const isMobile = useIsMobile();
  const autoScrollRef = useRef(true);
  const [mobileFileOverlayOpen, setMobileFileOverlayOpen] = useState(false);
  const [mobilePreviewFile, setMobilePreviewFile] = useState<FileAttachment | null>(null);

  const session = activeSessionId ? sessions.get(activeSessionId) : undefined;
  const messages = session?.messages || [];

  // Detect if Claude is currently processing
  const isRunning = useMemo(() => {
    if (!messages.length) return false;
    const last = messages[messages.length - 1];
    return last.type === 'assistant' && (last.state?.status === 'thinking' || last.state?.status === 'running');
  }, [messages]);

  const updateMessageState = useStore((s) => s.updateMessageState);

  // Stop the current task
  const handleStop = useCallback(() => {
    if (!activeSessionId) return;
    send({ type: 'stop', chatId: activeSessionId });

    // Optimistically update the running message to stopped state
    const sess = sessions.get(activeSessionId);
    if (sess) {
      const lastMsg = sess.messages[sess.messages.length - 1];
      if (lastMsg?.type === 'assistant' && (lastMsg.state?.status === 'thinking' || lastMsg.state?.status === 'running')) {
        const stoppedState: CardState = {
          ...lastMsg.state,
          status: 'error',
          errorMessage: 'Task stopped by user',
        };
        updateMessageState(activeSessionId, lastMsg.id, stoppedState);
      }
    }
  }, [activeSessionId, send, sessions, updateMessageState]);

  // Ensure a session exists, creating one if needed
  const ensureSession = useCallback(() => {
    if (activeSessionId) return activeSessionId;
    return createSession(activeBotName || undefined);
  }, [activeSessionId, activeBotName, createSession]);

  // ── RTC availability check ──
  const [rtcAvailable, setRtcAvailable] = useState(false);
  useEffect(() => {
    if (!token) return;
    fetch('/api/rtc/config', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((d) => setRtcAvailable(d.configured === true))
      .catch(() => setRtcAvailable(false));
  }, [token]);

  // ── HTTP Call mode (fallback) ──
  const httpCall = useCallMode({
    activeBotName, activeSessionId, token,
    onEnsureSession: ensureSession,
    autoScrollRef,
  });

  // ── RTC Call mode ──
  const handleRtcTranscript = useCallback((text: string) => {
    let sessionId = activeSessionId;
    if (!sessionId) sessionId = createSession(activeBotName || undefined);
    const userMsgId = generateId();
    const assistantMsgId = generateId();
    addMessage(sessionId, { id: userMsgId, type: 'user', text, timestamp: Date.now() });
    addMessage(sessionId, {
      id: assistantMsgId, type: 'assistant', text: '',
      state: { status: 'thinking', userPrompt: text, responseText: '', toolCalls: [] },
      timestamp: Date.now(),
    });
    send({ type: 'chat', botName: activeBotName || '', chatId: sessionId, text, messageId: assistantMsgId });
    autoScrollRef.current = true;
  }, [activeSessionId, activeBotName, createSession, addMessage, send]);

  const rtcCall = useRtcCallMode({ activeBotName, activeSessionId, token, messages, onTranscript: handleRtcTranscript });

  // ── Incoming voice call from agent ──
  const incomingVoiceCall = useStore((s) => s.incomingVoiceCall);
  const setIncomingVoiceCall = useStore((s) => s.setIncomingVoiceCall);

  useEffect(() => {
    if (incomingVoiceCall && !rtcCall.callActive) {
      // Auto-join the incoming call
      rtcCall.joinCall(incomingVoiceCall as IncomingVoiceCall);
      setIncomingVoiceCall(null);
    }
  }, [incomingVoiceCall, rtcCall.callActive, rtcCall.joinCall, setIncomingVoiceCall]);

  // Select active call mode
  const callActive = rtcAvailable ? rtcCall.callActive : httpCall.callActive;
  const startCall = useCallback(async () => {
    if (rtcAvailable) {
      rtcCall.startCall();
    } else {
      httpCall.startCall();
    }
  }, [rtcAvailable, rtcCall, httpCall]);
  const endCall = useCallback(() => {
    if (rtcAvailable) {
      rtcCall.endCall();
    } else {
      httpCall.endCall();
    }
  }, [rtcAvailable, rtcCall, httpCall]);

  // ── File panel ──
  const {
    filePanelOpen, setFilePanelOpen,
    filePanelWidth,
    previewFile, setPreviewFile,
    openPreview,
    allFiles,
    handleResizeStart,
  } = useFilePanel(messages);

  // On mobile, route file preview to the mobile overlay instead of the side panel
  const handlePreview = useCallback((file: FileAttachment) => {
    if (isMobile) {
      setMobilePreviewFile(file);
      setMobileFileOverlayOpen(true);
    } else {
      openPreview(file);
    }
  }, [isMobile, openPreview]);

  const handleFilePanelToggle = useCallback(() => {
    if (isMobile) {
      setMobileFileOverlayOpen(!mobileFileOverlayOpen);
      setMobilePreviewFile(null);
    } else {
      setFilePanelOpen(!filePanelOpen);
      if (filePanelOpen) setPreviewFile(null);
    }
  }, [isMobile, mobileFileOverlayOpen, filePanelOpen, setFilePanelOpen, setPreviewFile]);

  // ── Upload files to server ──
  const uploadFiles = useCallback(async (files: PendingFile[], sessionId: string): Promise<FileAttachment[]> => {
    const attachments: FileAttachment[] = [];
    for (const f of files) {
      try {
        const params = new URLSearchParams({ filename: f.file.name, chatId: sessionId });
        if (token) params.set('token', token);
        const res = await fetch(`/api/upload?${params.toString()}`, {
          method: 'POST',
          headers: {
            'Content-Type': f.file.type || 'application/octet-stream',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: f.file,
        });
        if (res.ok) {
          const data = await res.json();
          attachments.push({
            name: f.file.name,
            type: f.file.type || 'application/octet-stream',
            size: f.file.size,
            url: `/api/files/${encodeURIComponent(sessionId)}/${encodeURIComponent(data.filename)}`,
            path: data.path,
          });
        }
      } catch (err) {
        console.error(`Upload error for ${f.file.name}:`, err);
      }
    }
    return attachments;
  }, [token]);

  // ── Send message (called by InputBar) ──
  const handleSend = useCallback(async (text: string, files: PendingFile[]) => {
    const hasFiles = files.length > 0;

    let sessionId = activeSessionId;
    if (!sessionId) {
      sessionId = createSession(activeBotName || undefined);
    }

    // Check for /stop command
    if (text === '/stop' && !hasFiles) {
      send({ type: 'stop', chatId: sessionId });
      return;
    }

    // Upload files first if any
    let fileInfo = '';
    let attachments: FileAttachment[] = [];
    if (hasFiles) {
      attachments = await uploadFiles(files, sessionId);
      if (attachments.length > 0) {
        const lines = attachments.map((a) => {
          const cat = fileCategory(a.type);
          if (cat === 'image') return `  - ${a.path} (image: ${a.name}, ${formatFileSize(a.size)})`;
          if (cat === 'audio') return `  - ${a.path} (audio: ${a.name}, ${formatFileSize(a.size)})`;
          if (cat === 'video') return `  - ${a.path} (video: ${a.name}, ${formatFileSize(a.size)})`;
          return `  - ${a.path} (${a.name}, ${formatFileSize(a.size)})`;
        });
        fileInfo = `\n\nThe user uploaded ${attachments.length} file(s):\n${lines.join('\n')}\n\nFor text-based files (txt, csv, json, md, code, etc.), use the Read tool. For images, use the Read tool to view them. For binary files (pdf, docx, xlsx, etc.), acknowledge receipt and describe what you can help with.`;
      }
    }

    const fullText = (text + fileInfo).trim();

    if (!fullText) {
      if (hasFiles) {
        addMessage(sessionId, {
          id: generateId(), type: 'system',
          text: 'File upload failed. Please try again.',
          timestamp: Date.now(),
        });
      }
      return;
    }

    const displayText = text || '';
    const userMsgId = generateId();
    const assistantMsgId = generateId();

    addMessage(sessionId, {
      id: userMsgId, type: 'user', text: displayText,
      timestamp: Date.now(),
      ...(attachments.length > 0 ? { attachments } : {}),
    });

    addMessage(sessionId, {
      id: assistantMsgId, type: 'assistant', text: '',
      state: { status: 'thinking', userPrompt: fullText, responseText: '', toolCalls: [] },
      timestamp: Date.now(),
    });

    // Determine if this is a group chat
    const currentSession = sessions.get(sessionId);
    if (currentSession?.groupId) {
      send({
        type: 'group_chat',
        groupId: currentSession.groupId,
        chatId: sessionId,
        text: fullText,
        messageId: assistantMsgId,
      });
    } else {
      send({
        type: 'chat',
        botName: activeBotName || 'default',
        chatId: sessionId,
        text: fullText,
        messageId: assistantMsgId,
      });
    }

    autoScrollRef.current = true;
  }, [activeSessionId, activeBotName, createSession, addMessage, send, uploadFiles, sessions]);

  // ── Answer pending question ──
  const handleAnswer = useCallback(
    (toolUseId: string, answer: string) => {
      if (!activeSessionId) return;
      send({ type: 'answer', chatId: activeSessionId, toolUseId, answer });
    },
    [activeSessionId, send],
  );

  // ── Hint click ──
  const handleHintClick = useCallback((text: string) => {
    // InputBar manages its own input state; this triggers a send directly
    handleSend(text, []);
  }, [handleSend]);

  const hasMessages = messages.length > 0;

  return (
    <div className={styles.chatLayout}>
      <div className={styles.container}>
        {/* Messages or empty state */}
        {hasMessages ? (
          <MessageList
            messages={messages}
            onAnswer={handleAnswer}
            onPreview={handlePreview}
            autoScrollRef={autoScrollRef}
          />
        ) : (
          <EmptyState onHintClick={handleHintClick} botName={activeBotName} botDescription={activeBot?.description} />
        )}

        {/* Call overlay */}
        {callActive && (rtcAvailable ? (
          <RtcCallOverlayUI
            activeBotName={activeBotName}
            callElapsed={rtcCall.callElapsed}
            callPhase={rtcCall.callPhase}
            callStatusText={rtcCall.callStatusText}
            isMuted={rtcCall.isMuted}
            errorMessage={rtcCall.errorMessage}
            subtitleText={rtcCall.subtitleText}
            onToggleMute={rtcCall.toggleMute}
            onHangup={endCall}
          />
        ) : (
          <CallOverlayUI
            activeBotName={activeBotName}
            callElapsed={httpCall.callElapsed}
            callPhase={httpCall.callPhase}
            callStatusText={httpCall.callStatusText}
            onTap={httpCall.handleCallTap}
            onHangup={endCall}
          />
        ))}

        {/* Input area */}
        <InputBar
          connected={connected}
          isRunning={isRunning}
          onSend={handleSend}
          onStop={handleStop}
          onStartCall={startCall}
          callActive={callActive}
          send={send}
          sendBinary={sendBinary}
        />

        {/* File panel toggle button */}
        <FilePanelToggle
          count={allFiles.length}
          isOpen={isMobile ? mobileFileOverlayOpen : filePanelOpen}
          onClick={handleFilePanelToggle}
        />
      </div>

      {/* Right side panel (desktop) */}
      {!isMobile && filePanelOpen && allFiles.length > 0 && (
        <FilePanelContent
          allFiles={allFiles}
          previewFile={previewFile}
          setPreviewFile={setPreviewFile}
          filePanelWidth={filePanelWidth}
          handleResizeStart={handleResizeStart}
          openPreview={openPreview}
          onClose={() => setFilePanelOpen(false)}
        />
      )}

      {/* Mobile file overlay (fullscreen) */}
      {isMobile && mobileFileOverlayOpen && allFiles.length > 0 && (
        <MobileFileOverlay
          file={mobilePreviewFile}
          allFiles={allFiles}
          onClose={() => { setMobileFileOverlayOpen(false); setMobilePreviewFile(null); }}
          onSelectFile={(f) => setMobilePreviewFile(f)}
        />
      )}
    </div>
  );
}
