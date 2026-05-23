import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  // Relative base so the built SPA can be served from any mount path —
  // local `/web/` and cloud `/i/<instanceId>/web/` both work without rebuild.
  // The runtime derives BrowserRouter basename + API base from
  // window.location.pathname (see web/src/utils/transcriptPath.ts).
  base: './',
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          markdown: ['react-markdown', 'remark-gfm', 'rehype-highlight'],
          'office-preview': ['docx-preview', 'xlsx'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:9100',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:9100',
        ws: true,
      },
      '/memory': {
        target: 'http://localhost:8100',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/memory/, ''),
      },
    },
  },
});
