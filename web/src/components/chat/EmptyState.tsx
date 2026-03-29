/* ---- Empty State (shown when no messages) ---- */

import styles from '../ChatView.module.css';

interface Props {
  onHintClick: (text: string) => void;
  botName?: string | null;
  botDescription?: string;
}

export function EmptyState({ onHintClick, botName, botDescription }: Props) {
  const displayName = botName || 'MetaBot';
  const initial = displayName.charAt(0).toUpperCase();
  const description = botDescription || 'Your AI coding assistant. Ask me anything about code, architecture, debugging, or let me build something for you.';

  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyIcon}>
        <div className={styles.emptyIconInner}>{initial}</div>
      </div>
      <div className={styles.emptyTitle}>{displayName}</div>
      <div className={styles.emptySubtitle}>{description}</div>
      <div className={styles.emptyHints}>
        {[
          'Explain how this project works',
          'Find and fix bugs in my code',
          'Write tests for the main module',
          'Refactor this function',
        ].map((hint) => (
          <button
            key={hint}
            className={styles.emptyHint}
            onClick={() => onHintClick(hint)}
          >
            {hint}
          </button>
        ))}
      </div>
    </div>
  );
}
