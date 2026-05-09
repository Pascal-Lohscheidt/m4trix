import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/app',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    target: 'esnext',
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/trpc': 'http://127.0.0.1:4319',
    },
  },
});
