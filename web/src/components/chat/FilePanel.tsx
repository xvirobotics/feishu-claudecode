/* ---- Right-side File Panel with preview ---- */

import { useState, useCallback, useRef, useMemo } from 'react';
import type { FileAttachment, ChatMessage } from '../../types';
import { FileAttachmentCard } from './FileAttachmentCard';
import { FilePreviewContent } from './FilePreviewContent';
import { IconChevronLeft, IconDownload, IconX, IconFileSidebar } from './icons';
import styles from '../ChatView.module.css';

interface FilePanelProps {
  messages: ChatMessage[];
}

export function useFilePanel(messages: ChatMessage[]) {
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [filePanelWidth, setFilePanelWidth] = useState(420);
  const resizingRef = useRef(false);
  const [previewFile, setPreviewFile] = useState<FileAttachment | null>(null);

  const openPreview = useCallback((file: FileAttachment) => {
    setPreviewFile(file);
    setFilePanelOpen(true);
  }, []);

  const allFiles = useMemo(() => {
    const files: FileAttachment[] = [];
    for (const msg of messages) {
      if (msg.attachments) files.push(...msg.attachments);
    }
    return files;
  }, [messages]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const startX = e.clientX;
    const startWidth = filePanelWidth;

    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = startX - ev.clientX;
      setFilePanelWidth(Math.max(280, Math.min(700, startWidth + delta)));
    };
    const onUp = () => {
      resizingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [filePanelWidth]);

  return {
    filePanelOpen, setFilePanelOpen,
    filePanelWidth,
    previewFile, setPreviewFile,
    openPreview,
    allFiles,
    handleResizeStart,
  };
}

/* ---- File Panel Toggle Button ---- */

export function FilePanelToggle({
  count,
  isOpen,
  onClick,
}: {
  count: number;
  isOpen: boolean;
  onClick: () => void;
}) {
  if (count === 0) return null;
  return (
    <button
      className={`${styles.filePanelToggle} ${isOpen ? styles.filePanelToggleActive : ''}`}
      onClick={onClick}
      title={isOpen ? 'Hide files' : `Show files (${count})`}
    >
      <IconFileSidebar />
      <span className={styles.filePanelBadge}>{count}</span>
    </button>
  );
}

/* ---- File Panel Content ---- */

export function FilePanelContent({
  allFiles,
  previewFile,
  setPreviewFile,
  filePanelWidth,
  handleResizeStart,
  openPreview,
  onClose,
}: {
  allFiles: FileAttachment[];
  previewFile: FileAttachment | null;
  setPreviewFile: (f: FileAttachment | null) => void;
  filePanelWidth: number;
  handleResizeStart: (e: React.MouseEvent) => void;
  openPreview: (f: FileAttachment) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className={styles.resizeHandle} onMouseDown={handleResizeStart} />
      <div className={styles.filePanel} style={{ width: filePanelWidth }}>
        {previewFile ? (
          <>
            <div className={styles.filePanelHeader}>
              <button className={styles.panelBackBtn} onClick={() => setPreviewFile(null)} title="Back to files">
                <IconChevronLeft />
              </button>
              <span className={styles.previewTitle}>{previewFile.name}</span>
              <a href={previewFile.url} download={previewFile.name} className={styles.panelHeaderIcon} title="Download">
                <IconDownload />
              </a>
              <button className={styles.panelHeaderIcon} onClick={() => { onClose(); setPreviewFile(null); }}>
                <IconX />
              </button>
            </div>
            <div className={styles.previewBody}>
              <FilePreviewContent file={previewFile} />
            </div>
          </>
        ) : (
          <>
            <div className={styles.filePanelHeader}>
              <span>Files ({allFiles.length})</span>
              <button className={styles.filePanelClose} onClick={onClose}>
                <IconX />
              </button>
            </div>
            <div className={styles.filePanelList}>
              {allFiles.map((file, i) => (
                <FileAttachmentCard key={i} file={file} compact onPreview={openPreview} />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
