import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useStore } from './store';
import { LoginPage } from './components/LoginPage';
import { Layout } from './components/Layout';
import { ChatView } from './components/ChatView';
import { MemoryView } from './components/MemoryView';
import { VoiceView } from './components/VoiceView';
import { SettingsView } from './components/SettingsView';
import { TeamWorkspace } from './components/team';
import { TranscriptView } from './components/TranscriptView';
import { ErrorBoundary } from './components/ErrorBoundary';

export function App() {
  const token = useStore((s) => s.token);
  const location = useLocation();

  // Transcript pages have their own Feishu OAuth flow and must NOT be gated
  // by the local-token LoginPage. They render standalone (no Layout/sidebar).
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

  if (!token) {
    return <LoginPage />;
  }

  return (
    <ErrorBoundary>
      <Layout>
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<ChatView />} />
            <Route path="/memory" element={<MemoryView />} />
            <Route path="/voice" element={<VoiceView />} />
            <Route path="/settings" element={<SettingsView />} />
            <Route path="/team" element={<TeamWorkspace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </Layout>
    </ErrorBoundary>
  );
}
