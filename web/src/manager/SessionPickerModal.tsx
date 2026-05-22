/* ============================================================
   manager/SessionPickerModal.tsx — pick a session jsonl for a chatId.

   Lists `GET /api/manager/bots/:name/sessions/jsonls` and on confirm,
   `PATCH /api/manager/bots/:name/session { chatId, sessionId }`.
============================================================ */

import { useEffect, useMemo, useState } from 'react';
import { listJsonls, patchSession, ApiError, type JsonlInfo } from './api';
import { Modal } from './ui';
import { useToast } from './toast';
import styles from './manager.module.css';

interface SessionPickerModalProps {
  botName:          string;
  chatId:           string;
  currentSessionId: string;
  onClose:          () => void;
  onPicked:         () => void;
  onAuthLost:       () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function SessionPickerModal({
  botName,
  chatId,
  currentSessionId,
  onClose,
  onPicked,
  onAuthLost,
}: SessionPickerModalProps) {
  const toast                   = useToast();
  const [items, setItems]       = useState<JsonlInfo[]>([]);
  const [loading, setLoading]   = useState(true);
  const [selected, setSelected] = useState<string>(currentSessionId);
  const [saving, setSaving]     = useState(false);
  const [filter, setFilter]     = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { jsonls } = await listJsonls(botName);
        if (cancelled) return;
        const sorted = [...jsonls].sort((a, b) => b.mtimeMs - a.mtimeMs);
        setItems(sorted);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          onAuthLost();
          return;
        }
        toast.show(err instanceof Error ? err.message : '加载失败', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [botName, onAuthLost, toast]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (x) =>
        x.sessionId.toLowerCase().includes(q) ||
        (x.firstUserMessage ?? '').toLowerCase().includes(q) ||
        (x.lastUserMessage ?? '').toLowerCase().includes(q),
    );
  }, [items, filter]);

  async function handleConfirm() {
    if (!selected) return;
    if (selected === currentSessionId) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await patchSession(botName, chatId, selected);
      toast.show('已切换会话', 'success');
      onPicked();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      toast.show(err instanceof Error ? err.message : '切换失败', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={`选择会话 · ${chatId}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.actionBtn} onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            type="button"
            className={styles.actionBtn + ' ' + styles.actionBtnPrimary}
            onClick={handleConfirm}
            disabled={saving || !selected || selected === currentSessionId}
          >
            {saving ? '保存中…' : '确认切换'}
          </button>
        </>
      }
    >
      <div style={{ marginBottom: 12 }}>
        <input
          className={styles.input}
          placeholder="按 sessionId / 内容搜索…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {loading ? (
        <div className={styles.dim}>加载中…</div>
      ) : filtered.length === 0 ? (
        <div className={styles.dim}>没有匹配的会话文件</div>
      ) : (
        <div>
          {filtered.map((item) => {
            const active = item.sessionId === selected;
            return (
              <div
                key={item.sessionId}
                className={styles.jsonlItem + ' ' + (active ? styles.jsonlItemActive : '')}
                onClick={() => setSelected(item.sessionId)}
                tabIndex={0}
                role="button"
                aria-pressed={active}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelected(item.sessionId);
                  }
                }}
              >
                <div className={styles.jsonlId}>
                  {item.sessionId}
                  {item.sessionId === currentSessionId && (
                    <span style={{ marginLeft: 8, color: 'var(--accent-text)' }}>(当前)</span>
                  )}
                </div>
                <div className={styles.jsonlMeta}>
                  {formatSize(item.sizeBytes)} · {formatTime(item.mtimeMs)}
                </div>
                {(item.firstUserMessage || item.lastUserMessage) && (
                  <div className={styles.jsonlPreview}>
                    {item.firstUserMessage && <>首: {item.firstUserMessage}</>}
                    {item.firstUserMessage && item.lastUserMessage && <br />}
                    {item.lastUserMessage && <>末: {item.lastUserMessage}</>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
