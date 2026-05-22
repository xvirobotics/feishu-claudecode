/* ============================================================
   manager/LoginPage.tsx — username + password admin login.
============================================================ */

import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { authLogin, ApiError } from './api';
import { useBodyScroll } from './toast';
import styles from './manager.module.css';

interface LoginPageProps {
  onAuthed: (username: string) => void;
}

export function LoginPage({ onAuthed }: LoginPageProps) {
  useBodyScroll();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  // Where to go after success: ?next=/manager/dashboard or default
  const params = new URLSearchParams(location.search);
  const next   = params.get('next') || '/manager/dashboard';

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('请填写用户名和密码');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await authLogin(username.trim(), password);
      onAuthed(res.username);
      // Strip the /web basename if next contains it; React Router uses basename-relative paths
      const target = next.startsWith('/web') ? next.slice(4) : next;
      navigate(target || '/manager/dashboard', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('用户名或密码错误');
      } else if (err instanceof Error) {
        setError(err.message || '登录失败');
      } else {
        setError('登录失败');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.loginWrap}>
      <div className={styles.loginCard}>
        <div className={styles.loginTitle}>
          <div className={styles.loginIcon}>M</div>
          <span>MetaBot Manager</span>
        </div>
        <div className={styles.loginSubtitle}>登录后管理你的 bot 队列</div>

        <form onSubmit={handleSubmit} noValidate>
          <div className={styles.formField}>
            <label htmlFor="mgr-user" className={styles.label}>用户名</label>
            <input
              id="mgr-user"
              className={styles.input}
              type="text"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              spellCheck={false}
            />
          </div>

          <div className={styles.formField}>
            <label htmlFor="mgr-pw" className={styles.label}>密码</label>
            <input
              id="mgr-pw"
              className={styles.input}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && <div className={styles.errorBanner}>{error}</div>}

          <button
            type="submit"
            className={styles.submitBtn}
            disabled={loading || !username.trim() || !password}
          >
            {loading ? '登录中…' : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
}
