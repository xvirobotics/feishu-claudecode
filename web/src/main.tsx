import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './theme.css';

// Apply persisted theme
const theme = localStorage.getItem('metabot:theme') || 'dark';
document.documentElement.setAttribute('data-theme', theme);

// Apply persisted font scale
const fontSize = localStorage.getItem('metabot:fontsize') || 'normal';
const fontScales: Record<string, string> = { small: '0.9', normal: '1', large: '1.1', xl: '1.25' };
document.documentElement.style.setProperty('--font-scale', fontScales[fontSize] || '1');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename="/web">
      <App />
    </BrowserRouter>
  </StrictMode>,
);
