import { useState } from 'react';
import { useStore } from '../../store';
import type { WSOutgoingMessage } from '../../types';

interface GroupCreateDialogProps {
  onClose: () => void;
  onSend: (msg: WSOutgoingMessage) => void;
}

export function GroupCreateDialog({ onClose, onSend }: GroupCreateDialogProps) {
  const bots = useStore((s) => s.bots);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (botName: string) => {
    const next = new Set(selected);
    if (next.has(botName)) next.delete(botName);
    else next.add(botName);
    setSelected(next);
  };

  const handleCreate = () => {
    if (!name.trim() || selected.size < 2) return;
    onSend({ type: 'create_group', name: name.trim(), members: Array.from(selected) });
    onClose();
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h3 style={styles.title}>New Group</h3>

        <input
          style={styles.input}
          placeholder="Group name..."
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />

        <div style={styles.label}>Select members (at least 2):</div>
        <div style={styles.botList}>
          {bots.map((bot) => (
            <label key={bot.name} style={styles.botItem}>
              <input
                type="checkbox"
                checked={selected.has(bot.name)}
                onChange={() => toggle(bot.name)}
              />
              <span style={styles.botName}>{bot.name}</span>
              {bot.platform === 'web' && <span style={styles.badge}>Web</span>}
            </label>
          ))}
        </div>

        <div style={styles.actions}>
          <button style={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            style={{
              ...styles.createBtn,
              opacity: name.trim() && selected.size >= 2 ? 1 : 0.4,
            }}
            disabled={!name.trim() || selected.size < 2}
            onClick={handleCreate}
          >
            Create Group
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  dialog: {
    background: 'var(--surface-1)',
    borderRadius: 'var(--r-lg)',
    padding: '24px',
    width: '360px',
    maxWidth: '90vw',
    border: '1px solid var(--glass-border)',
    boxShadow: 'var(--shadow-lg)',
  },
  title: {
    margin: '0 0 16px',
    fontSize: '16px',
    fontWeight: 600,
    color: 'var(--text-0)',
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 'var(--r-md)',
    border: '1px solid var(--glass-border)',
    background: 'var(--surface-0)',
    color: 'var(--text-0)',
    fontSize: '14px',
    outline: 'none',
    boxSizing: 'border-box',
  },
  label: {
    margin: '14px 0 8px',
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--text-2)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  botList: {
    maxHeight: '200px',
    overflowY: 'auto' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
  },
  botItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 10px',
    borderRadius: 'var(--r-sm)',
    cursor: 'pointer',
    fontSize: '13px',
    color: 'var(--text-1)',
    transition: 'background 150ms',
  },
  botName: {
    flex: 1,
  },
  badge: {
    fontSize: '9px',
    fontWeight: 600,
    color: 'var(--accent-text)',
    background: 'var(--accent-softer)',
    padding: '1px 5px',
    borderRadius: 'var(--r-xs)',
    letterSpacing: '0.5px',
    textTransform: 'uppercase' as const,
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    marginTop: '18px',
  },
  cancelBtn: {
    padding: '8px 16px',
    borderRadius: 'var(--r-md)',
    fontSize: '13px',
    fontWeight: 500,
    color: 'var(--text-1)',
    background: 'var(--surface-hover)',
    cursor: 'pointer',
    border: 'none',
  },
  createBtn: {
    padding: '8px 16px',
    borderRadius: 'var(--r-md)',
    fontSize: '13px',
    fontWeight: 600,
    color: '#fff',
    background: 'var(--gradient-accent)',
    cursor: 'pointer',
    border: 'none',
  },
};
