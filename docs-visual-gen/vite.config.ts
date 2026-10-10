import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Scenes only ever run in a current Chrome, so skip down-levelling (animejs uses modern syntax).
const target = 'es2022';

export default defineConfig({
  plugins: [react()],
  server: { port: 5199 },
  esbuild: { target },
  optimizeDeps: { esbuildOptions: { target } },
  build: { target },
});
