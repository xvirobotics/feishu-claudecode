import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './theme.css';

// Apply persisted theme
const theme = localStorage.getItem('metabot:theme') || 'dark';
document.documentElement.setAttribute('data-theme', theme);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename="/web">
      <App />
    </BrowserRouter>
  </StrictMode>,
);
