import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Suspense, lazy } from 'react';
import { useStore } from './store';
import { TranscriptView } from './components/TranscriptView';
import { ErrorBoundary } from './components/ErrorBoundary';

// Non-transcript routes are lazy-loaded so the public transcript page
// doesn't ship the in-app SPA (ChatView/Memory/Voice/Settings/Team/Login).
const LoginPage     = lazy(() => import('./components/LoginPage').then((m) => ({ default: m.LoginPage })));
const Layout        = lazy(() => import('./components/Layout').then((m) => ({ default: m.Layout })));
const ChatView      = lazy(() => import('./components/ChatView').then((m) => ({ default: m.ChatView })));
const MemoryView    = lazy(() => import('./components/MemoryView').then((m) => ({ default: m.MemoryView })));
const VoiceView     = lazy(() => import('./components/VoiceView').then((m) => ({ default: m.VoiceView })));
const SettingsView  = lazy(() => import('./components/SettingsView').then((m) => ({ default: m.SettingsView })));
const TeamWorkspace = lazy(() => import('./components/team').then((m) => ({ default: m.TeamWorkspace })));
const ManagerApp    = lazy(() => import('./manager/ManagerApp').then((m) => ({ default: m.ManagerApp })));

function AppFallback() {
  return (
    <div style={{
      position:       'fixed',
      inset:          0,
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
      color:          'inherit',
      opacity:        0.7,
      fontSize:       14,
    }}>正在加载…</div>
  );
}

export function App() {
  const token = useStore((s) => s.token);
  const location = useLocation();

  // Transcript pages have their own Feishu OAuth flow and must NOT be gated
  // by the local-token LoginPage. They render standalone (no Layout/sidebar).
  // Kept eager so the transcript critical path is purely:
  //   vendor + markdown + this main chunk (no extra lazy hop).
  const isTranscriptRoute = location.pathname.startsWith('/transcript/');

  if (isTranscriptRoute) {
    return (
      <ErrorBoundary>
        <Routes>
          <Route path="/transcript/:chatId" element={<TranscriptView />} />
        </Routes>
      </ErrorBoundary>
    );
  }

  // Manager admin panel has its OWN auth flow (username/password + HttpOnly
  // cookie). It must NOT be intercepted by the local-token LoginPage gate.
  const isManagerRoute = location.pathname.startsWith('/manager');

  if (isManagerRoute) {
    return (
      <ErrorBoundary>
        <Suspense fallback={<AppFallback />}>
          <Routes>
            <Route path="/manager/*" element={<ManagerApp />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    );
  }

  if (!token) {
    return (
      <Suspense fallback={<AppFallback />}>
        <LoginPage />
      </Suspense>
    );
  }

  return (
    <ErrorBoundary>
      <Suspense fallback={<AppFallback />}>
        <Layout>
          <ErrorBoundary>
            <Routes>
              <Route path="/"         element={<ChatView />} />
              <Route path="/memory"   element={<MemoryView />} />
              <Route path="/voice"    element={<VoiceView />} />
              <Route path="/settings" element={<SettingsView />} />
              <Route path="/team"     element={<TeamWorkspace />} />
              <Route path="*"         element={<Navigate to="/" replace />} />
            </Routes>
          </ErrorBoundary>
        </Layout>
      </Suspense>
    </ErrorBoundary>
  );
}
