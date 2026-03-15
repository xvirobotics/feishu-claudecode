/* ---- Empty State (shown when no messages) ---- */

import styles from '../ChatView.module.css';

interface Props {
  onHintClick: (text: string) => void;
}

export function EmptyState({ onHintClick }: Props) {
  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyIcon}>
        <div className={styles.emptyIconInner}>M</div>
      </div>
      <div className={styles.emptyTitle}>MetaBot</div>
      <div className={styles.emptySubtitle}>
        Your AI coding assistant. Ask me anything about code, architecture, debugging, or let me build something for you.
      </div>
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
