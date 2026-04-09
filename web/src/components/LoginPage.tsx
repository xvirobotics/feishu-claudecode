import { useState, type FormEvent } from 'react';
import { useStore } from '../store';
import { requestNotificationPermission } from '../utils/notifications';
import styles from './LoginPage.module.css';

export function LoginPage() {
  const login = useStore((s) => s.login);
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const t = tokenInput.trim();
    if (!t) {
      setError('Please enter an API token.');
      return;
    }
    setError('');
    setLoading(true);

    // Try validating the token against the API
    try {
      const res = await fetch('/api/status', {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (res.ok) {
        login(t);
        requestNotificationPermission();
      } else if (res.status === 401 || res.status === 403) {
        setError('Invalid token. Please check and try again.');
      } else {
        // Server might not have /api/status — just accept the token
        login(t);
      }
    } catch {
      // Network error or no server — accept the token anyway (WebSocket will validate)
      login(t);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <div className={styles.logoIcon}>M</div>
          <span className={styles.logoText}>MetaBot</span>
        </div>

        <p className={styles.subtitle}>
          Connect to your Claude Code agent.
          <br />
          Enter your API token to get started.
        </p>

        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.inputGroup}>
            <label className={styles.inputLabel} htmlFor="token-input">
              API Token
            </label>
            <input
              id="token-input"
              className={styles.input}
              type="password"
              placeholder="mb-xxxxxxxxxxxxxxxx"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {error && <div className={styles.error}>{error}</div>}

          <button
            type="submit"
            className={styles.submitBtn}
            disabled={loading || !tokenInput.trim()}
          >
            {loading ? 'Connecting...' : 'Connect'}
          </button>
        </form>

        <div className={styles.footer}>
          Powered by{' '}
          <a
            href="https://github.com/anthropics/claude-code"
            target="_blank"
            rel="noopener noreferrer"
          >
            Claude Code Agent SDK
          </a>
        </div>
      </div>
    </div>
  );
}
