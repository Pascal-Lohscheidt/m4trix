import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const shim = (name: string) =>
  fileURLToPath(
    new URL(`./src/app/lib/payload-mapper/providers/browser-shims/${name}`, import.meta.url),
  );

export default defineConfig({
  root: 'src/app',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      // `@anthropic-ai/bedrock-sdk` (Mantle client) references Node-only modules on code paths
      // the browser never takes; see browser-shims/*.ts.
      { find: /^assert$/, replacement: shim('assert.ts') },
      {
        find: /^@aws-sdk\/credential-providers$/,
        replacement: shim('aws-credential-providers.ts'),
      },
    ],
  },
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
