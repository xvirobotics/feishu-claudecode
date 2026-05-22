/* ============================================================
   manager/toast.tsx — minimal toast context for the admin panel.

   Avoids pulling a dep. Toasts auto-dismiss after 4s.
============================================================ */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import styles from './manager.module.css';

export type ToastKind = 'info' | 'error' | 'success';

interface ToastItem {
  id:   number;
  kind: ToastKind;
  text: string;
}

interface ToastCtx {
  show: (text: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastCtx | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const show = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = nextId++;
    setItems((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((x) => x.id !== id));
    }, 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className={styles.toastWrap}>
        {items.map((t) => (
          <div
            key={t.id}
            className={
              styles.toast +
              ' ' +
              (t.kind === 'error' ? styles.toastError : t.kind === 'success' ? styles.toastSuccess : '')
            }
            role="status"
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Render-safe fallback so unwrapped usage doesn't crash; warns once.
    return {
      show: (text) => {
        // eslint-disable-next-line no-console
        if (typeof window !== 'undefined') window.alert(text);
      },
    };
  }
  return ctx;
}

/** Hook to use body-overflow auto on pages that need window scrolling.
 *  theme.css sets body{overflow:hidden} for the SPA shell; manager pages scroll the window. */
export function useBodyScroll() {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'auto';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
}
