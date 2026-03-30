import { useState, type FormEvent } from 'react';
import { useStore } from '../store';
import type { UserInfo } from '../types';
import styles from './LoginPage.module.css';

type Mode = 'login' | 'register' | 'token';

export function LoginPage() {
  const { login, loginWithUser } = useStore((s) => ({
    login: s.login,
    loginWithUser: s.loginWithUser,
  }));
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('Please fill in all fields.');
      return;
    }
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (res.ok) {
        loginWithUser(data.token, data as UserInfo);
      } else {
        setError(data.error || 'Login failed');
      }
    } catch {
      setError('Network error. Is the server running?');
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('Please fill in all fields.');
      return;
    }
    if (password.length < 4) {
      setError('Password must be at least 4 characters.');
      return;
    }
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          password,
          displayName: displayName.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        loginWithUser(data.token, data as UserInfo);
      } else {
        setError(data.error || 'Registration failed');
      }
    } catch {
      setError('Network error. Is the server running?');
    } finally {
      setLoading(false);
    }
  }

  async function handleTokenLogin(e: FormEvent) {
    e.preventDefault();
    const t = tokenInput.trim();
    if (!t) {
      setError('Please enter a token.');
      return;
    }
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (res.ok) {
        const data = await res.json();
        loginWithUser(t, data as UserInfo);
      } else {
        // Fallback: try legacy token (just accept it)
        login(t);
      }
    } catch {
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
          {mode === 'login' && 'Sign in to your account'}
          {mode === 'register' && 'Create a new account'}
          {mode === 'token' && 'Connect with API token'}
        </p>

        {mode === 'login' && (
          <form className={styles.form} onSubmit={handleLogin}>
            <div className={styles.inputGroup}>
              <label className={styles.inputLabel} htmlFor="login-username">Username</label>
              <input
                id="login-username"
                className={styles.input}
                type="text"
                placeholder="Enter username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
              />
            </div>
            <div className={styles.inputGroup}>
              <label className={styles.inputLabel} htmlFor="login-password">Password</label>
              <input
                id="login-password"
                className={styles.input}
                type="password"
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            {error && <div className={styles.error}>{error}</div>}
            <button type="submit" className={styles.submitBtn} disabled={loading}>
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        )}

        {mode === 'register' && (
          <form className={styles.form} onSubmit={handleRegister}>
            <div className={styles.inputGroup}>
              <label className={styles.inputLabel} htmlFor="reg-username">Username</label>
              <input
                id="reg-username"
                className={styles.input}
                type="text"
                placeholder="Choose a username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
              />
            </div>
            <div className={styles.inputGroup}>
              <label className={styles.inputLabel} htmlFor="reg-display">Display Name</label>
              <input
                id="reg-display"
                className={styles.input}
                type="text"
                placeholder="Optional"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
              />
            </div>
            <div className={styles.inputGroup}>
              <label className={styles.inputLabel} htmlFor="reg-password">Password</label>
              <input
                id="reg-password"
                className={styles.input}
                type="password"
                placeholder="At least 4 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            {error && <div className={styles.error}>{error}</div>}
            <button type="submit" className={styles.submitBtn} disabled={loading}>
              {loading ? 'Creating account...' : 'Create Account'}
            </button>
          </form>
        )}

        {mode === 'token' && (
          <form className={styles.form} onSubmit={handleTokenLogin}>
            <div className={styles.inputGroup}>
              <label className={styles.inputLabel} htmlFor="token-input">API Token</label>
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
            <button type="submit" className={styles.submitBtn} disabled={loading || !tokenInput.trim()}>
              {loading ? 'Connecting...' : 'Connect'}
            </button>
          </form>
        )}

        <div className={styles.modeSwitch}>
          {mode === 'login' && (
            <>
              <button className={styles.modeBtn} onClick={() => { setMode('register'); setError(''); }}>
                Create account
              </button>
              <span className={styles.modeDivider}>|</span>
              <button className={styles.modeBtn} onClick={() => { setMode('token'); setError(''); }}>
                Use API token
              </button>
            </>
          )}
          {mode === 'register' && (
            <button className={styles.modeBtn} onClick={() => { setMode('login'); setError(''); }}>
              Already have an account? Sign in
            </button>
          )}
          {mode === 'token' && (
            <button className={styles.modeBtn} onClick={() => { setMode('login'); setError(''); }}>
              Sign in with username
            </button>
          )}
        </div>

        <div className={styles.footer}>
          Powered by{' '}
          <a href="https://github.com/anthropics/claude-code" target="_blank" rel="noopener noreferrer">
            Claude Code Agent SDK
          </a>
        </div>
      </div>
    </div>
  );
}
