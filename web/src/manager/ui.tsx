/* ============================================================
   manager/ui.tsx — tiny shared UI bits (status pill, confirm modal).
============================================================ */

import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { X } from 'lucide-react';
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
            <X size={18} strokeWidth={2} />
          </button>
        </div>
        <div className={styles.modalBody}>{children}</div>
        {footer && <div className={styles.modalFooter}>{footer}</div>}
      </div>
    </div>
  );
}

/* ── Switch ────────────────────────────────────────────────
   Tiny iOS-style toggle. div + transform; no library. Disabled
   state dims and blocks clicks. Used by hubVisible toggle.
============================================================ */
export interface SwitchProps {
  checked:    boolean;
  onChange:   (v: boolean) => void;
  disabled?:  boolean;
  ariaLabel?: string;
}

export function Switch({ checked, onChange, disabled = false, ariaLabel }: SwitchProps) {
  const trackStyle: CSSProperties = {
    position:        'relative',
    display:         'inline-block',
    width:           36,
    height:          20,
    borderRadius:    999,
    background:      checked ? 'var(--accent, #2563eb)' : 'var(--surface-hover, #d1d5db)',
    transition:      'background 120ms ease',
    cursor:          disabled ? 'not-allowed' : 'pointer',
    opacity:         disabled ? 0.5 : 1,
    flexShrink:      0,
    verticalAlign:   'middle',
  };
  const knobStyle: CSSProperties = {
    position:        'absolute',
    top:             2,
    left:            2,
    width:           16,
    height:          16,
    borderRadius:    '50%',
    background:      '#fff',
    boxShadow:       '0 1px 2px rgba(0,0,0,0.25)',
    transform:       checked ? 'translateX(16px)' : 'translateX(0)',
    transition:      'transform 140ms ease',
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{ background: 'none', border: 'none', padding: 0, lineHeight: 0 }}
    >
      <span style={trackStyle}>
        <span style={knobStyle} />
      </span>
    </button>
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
