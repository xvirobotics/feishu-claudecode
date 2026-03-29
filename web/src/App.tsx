import { Routes, Route, Navigate } from 'react-router-dom';
import { useStore } from './store';
import { LoginPage } from './components/LoginPage';
import { Layout } from './components/Layout';
import { ChatView } from './components/ChatView';
import { MemoryView } from './components/MemoryView';
import { VoiceView } from './components/VoiceView';
import { SettingsView } from './components/SettingsView';
import { TeamWorkspace } from './components/team';
import { ErrorBoundary } from './components/ErrorBoundary';

export function App() {
  const token = useStore((s) => s.token);

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
