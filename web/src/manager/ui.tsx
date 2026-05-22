/* ============================================================
   manager/ui.tsx — tiny shared UI bits (status pill, confirm modal).
============================================================ */

import { useEffect, type ReactNode } from 'react';
import type { BotStatus } from './api';
import styles from './manager.module.css';

const STATUS_LABEL: Record<BotStatus, string> = {
  online:    'ONLINE',
  stopped:   'STOPPED',
  errored:   'ERRORED',
  launching: 'LAUNCHING',
  unknown:   'UNKNOWN',
};

const STATUS_CLASS: Record<BotStatus, string> = {
  online:    styles.pillOnline,
  stopped:   styles.pillStopped,
  errored:   styles.pillErrored,
  launching: styles.pillLaunching,
  unknown:   styles.pillUnknown,
};

export function StatusPill({ status }: { status: BotStatus }) {
  return (
    <span className={styles.statusPill + ' ' + STATUS_CLASS[status]}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export interface ModalProps {
  title:     string;
  onClose:   () => void;
  children:  ReactNode;
  footer?:   ReactNode;
  maxWidth?: number;
}

export function Modal({ title, onClose, children, footer, maxWidth }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div
        className={styles.modalCard}
        style={maxWidth ? { maxWidth } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <span>{title}</span>
          <button
            type="button"
            className={styles.modalClose}
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
        <div className={styles.modalBody}>{children}</div>
        {footer && <div className={styles.modalFooter}>{footer}</div>}
      </div>
    </div>
  );
}

export interface ConfirmModalProps {
  title:           string;
  message:         ReactNode;
  warn?:           ReactNode;
  confirmText?:    string;
  cancelText?:     string;
  danger?:         boolean;
  onConfirm:       () => void;
  onCancel:        () => void;
  busy?:           boolean;
}

export function ConfirmModal({
  title,
  message,
  warn,
  confirmText = '确认',
  cancelText  = '取消',
  danger      = false,
  onConfirm,
  onCancel,
  busy        = false,
}: ConfirmModalProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      maxWidth={480}
      footer={
        <>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={onCancel}
            disabled={busy}
          >
            {cancelText}
          </button>
          <button
            type="button"
            className={
              styles.actionBtn + ' ' + (danger ? styles.actionBtnDanger : styles.actionBtnPrimary)
            }
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '执行中…' : confirmText}
          </button>
        </>
      }
    >
      <div className={styles.confirmText}>{message}</div>
      {warn && <div className={styles.confirmWarn}>{warn}</div>}
    </Modal>
  );
}
