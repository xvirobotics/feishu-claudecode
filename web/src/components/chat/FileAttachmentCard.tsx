/* ---- File Attachment Card ---- */

import type { FileAttachment } from '../../types';
import { fileCategory, fileExt, formatFileSize } from './helpers';
import { IconFile, IconDownload } from './icons';
import styles from '../ChatView.module.css';

interface Props {
  file: FileAttachment;
  compact?: boolean;
  onPreview?: (f: FileAttachment) => void;
}

export function FileAttachmentCard({ file, compact, onPreview }: Props) {
  const cat = fileCategory(file.type);
  const ext = fileExt(file.name);

  const handleClick = () => {
    if (onPreview) onPreview(file);
  };

  /* Image card */
  if (cat === 'image') {
    return (
      <div className={styles.attachCard} onClick={handleClick} style={{ cursor: onPreview ? 'pointer' : undefined }}>
        <img src={file.url} alt={file.name} className={compact ? styles.attachImgCompact : styles.attachImg} loading="lazy" />
        <span className={styles.attachName}>{file.name}</span>
      </div>
    );
  }

  /* Video card */
  if (cat === 'video') {
    return (
      <div className={styles.attachCard} onClick={handleClick} style={{ cursor: onPreview ? 'pointer' : undefined }}>
        <video src={file.url} className={compact ? styles.attachVideoCompact : styles.attachVideo} muted preload="metadata" />
        <span className={styles.attachName}>{file.name}</span>
      </div>
    );
  }

  /* Audio card */
  if (cat === 'audio') {
    return (
      <div className={styles.attachCardAudio} onClick={handleClick} style={{ cursor: onPreview ? 'pointer' : undefined }}>
        <div className={styles.attachAudioInfo}>
          <IconFile /> <span style={{ fontSize: 12 }}>{file.name}</span>
        </div>
        <audio src={file.url} controls className={styles.attachAudio} onClick={(e) => e.stopPropagation()} />
      </div>
    );
  }

  /* Generic file card */
  return (
    <div className={styles.attachCardFile} onClick={handleClick} style={{ cursor: onPreview ? 'pointer' : undefined }}>
      <div className={styles.attachFileIcon}>
        <span className={styles.attachFileExt}>{ext || '?'}</span>
      </div>
      <div className={styles.attachFileMeta}>
        <span className={styles.attachFileName}>{file.name}</span>
        <span className={styles.attachFileSize}>{formatFileSize(file.size)}</span>
      </div>
      <a
        href={file.url}
        download={file.name}
        className={styles.attachFileDownload}
        onClick={(e) => e.stopPropagation()}
        title="Download"
      >
        <IconDownload />
      </a>
    </div>
  );
}
