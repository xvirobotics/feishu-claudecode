import { useStore } from '../store';
import styles from './SettingsView.module.css';

export function SettingsView() {
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const fontSize = useStore((s) => s.fontSize);
  const setFontSize = useStore((s) => s.setFontSize);
  const token = useStore((s) => s.token);
  const logout = useStore((s) => s.logout);
  const connected = useStore((s) => s.connected);
  const bots = useStore((s) => s.bots);
  const sessions = useStore((s) => s.sessions);
  const clearSessions = useStore((s) => s.clearSessions);

  const maskedToken = token
    ? `${token.slice(0, 6)}${'*'.repeat(Math.min(token.length - 6, 20))}`
    : 'Not set';

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Settings</h1>
        <p className={styles.subtitle}>
          Manage your MetaBot configuration and preferences.
        </p>
      </div>

      {/* Appearance */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Appearance</h2>
        <div className={styles.card}>
          <div className={styles.cardItem}>
            <div className={styles.cardItemLeft}>
              <span className={styles.cardItemLabel}>Dark Mode</span>
              <span className={styles.cardItemDesc}>
                Toggle between dark and light themes
              </span>
            </div>
            <button
              className={`${styles.toggle} ${
                theme === 'dark' ? styles.toggleOn : ''
              }`}
              onClick={toggleTheme}
              aria-label="Toggle theme"
            />
          </div>

          <div className={styles.cardItem}>
            <div className={styles.cardItemLeft}>
              <span className={styles.cardItemLabel}>Font Size</span>
              <span className={styles.cardItemDesc}>
                Adjust text size for readability
              </span>
            </div>
            <div className={styles.fontSizeGroup}>
              {(['small', 'normal', 'large', 'xl'] as const).map((size) => (
                <button
                  key={size}
                  className={`${styles.fontSizeBtn} ${
                    fontSize === size ? styles.fontSizeBtnActive : ''
                  }`}
                  onClick={() => setFontSize(size)}
                >
                  {{ small: 'S', normal: 'M', large: 'L', xl: 'XL' }[size]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Connection */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Connection</h2>
        <div className={styles.card}>
          <div className={styles.cardItem}>
            <div className={styles.cardItemLeft}>
              <span className={styles.cardItemLabel}>Status</span>
              <span className={styles.cardItemDesc}>
                WebSocket connection to MetaBot server
              </span>
            </div>
            <span
              className={`${styles.connBadge} ${
                connected ? styles.connBadgeOnline : styles.connBadgeOffline
              }`}
            >
              <span
                className={`${styles.connDot} ${
                  connected ? styles.connDotOn : styles.connDotOff
                }`}
              />
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>

          <div className={styles.cardItem}>
            <div className={styles.cardItemLeft}>
              <span className={styles.cardItemLabel}>API Token</span>
              <span className={styles.cardItemDesc}>{maskedToken}</span>
            </div>
            <button
              className={`${styles.btn} ${styles.btnOutline}`}
              onClick={logout}
            >
              Disconnect
            </button>
          </div>
        </div>
      </div>

      {/* Bots */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>
          Bots ({bots.length})
        </h2>
        <div className={styles.card}>
          {bots.length === 0 ? (
            <div className={styles.cardItem}>
              <div className={styles.cardItemLeft}>
                <span className={styles.cardItemLabel}>No bots available</span>
                <span className={styles.cardItemDesc}>
                  {connected
                    ? 'No bots are configured on the server'
                    : 'Connect to see available bots'}
                </span>
              </div>
            </div>
          ) : (
            <div className={styles.botList}>
              {bots.map((bot) => (
                <div key={bot.name} className={styles.botItem}>
                  <span
                    className={`${styles.botDot} ${
                      connected ? styles.botDotOnline : styles.botDotOffline
                    }`}
                  />
                  <div className={styles.botInfo}>
                    <div className={styles.botName}>{bot.name}</div>
                    <div className={styles.botMeta}>
                      {bot.platform} &middot; {bot.workingDirectory}
                    </div>
                    {bot.description && (
                      <div
                        className={styles.cardItemDesc}
                        style={{ marginTop: '2px' }}
                      >
                        {bot.description}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Data */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Data</h2>
        <div className={styles.card}>
          <div className={styles.cardItem}>
            <div className={styles.cardItemLeft}>
              <span className={styles.cardItemLabel}>Chat History</span>
              <span className={styles.cardItemDesc}>
                {sessions.size} conversation{sessions.size !== 1 ? 's' : ''}{' '}
                stored locally
              </span>
            </div>
            <button
              className={`${styles.btn} ${styles.btnDanger}`}
              onClick={() => {
                if (
                  window.confirm(
                    'Clear all conversations? This cannot be undone.',
                  )
                ) {
                  clearSessions();
                }
              }}
            >
              Clear All
            </button>
          </div>
        </div>
      </div>

      {/* Version */}
      <div className={styles.version}>
        MetaBot Web &middot; Built with{' '}
        <a
          href="https://github.com/anthropics/claude-code"
          target="_blank"
          rel="noopener noreferrer"
        >
          Claude Code
        </a>
      </div>
    </div>
  );
}
