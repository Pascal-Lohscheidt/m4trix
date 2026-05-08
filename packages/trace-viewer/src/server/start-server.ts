import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TraceViewerApi } from '@m4trix/tracing';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { appRouter } from './router';

/**
 * `import.meta.url` is the emitting file. When this module is bundled into `dist/cli.js`
 * or `dist/index.js`, that directory is `dist/`, and the UI bundle lives at `dist/app/bundle.js`.
 * When run as `dist/server/start-server.js`, the bundle is one level up: `dist/app/bundle.js`.
 */
function bundlePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const nextToEmitter = join(here, 'app', 'bundle.js');
  const fromServerSubdir = join(here, '..', 'app', 'bundle.js');
  if (existsSync(nextToEmitter)) return nextToEmitter;
  if (existsSync(fromServerSubdir)) return fromServerSubdir;
  return nextToEmitter;
}

function htmlPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>m4trix trace viewer</title>
  <style>
    :root {
      color-scheme: dark;
      --zinc-950: #09090b;
      --zinc-900: #18181b;
      --zinc-800: #27272a;
      --zinc-700: #3f3f46;
      --zinc-500: #71717a;
      --zinc-200: #e4e4e7;
      --amber-400: #fbbf24;
      --emerald-400: #34d399;
      --red-400: #f87171;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background: var(--zinc-950);
      color: var(--zinc-200);
      min-height: 100vh;
    }
    #root { min-height: 100vh; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/assets/bundle.js"></script>
</body>
</html>`;
}

export type StartServerOptions = {
  traceViewerApi: TraceViewerApi;
  port: number;
  host?: string;
};

export function startTraceViewerServer(options: StartServerOptions): http.Server {
  const { traceViewerApi, port, host = '127.0.0.1' } = options;

  const trpcHandler = createHTTPHandler({
    router: appRouter,
    createContext: () => ({ traceViewerApi }),
    basePath: '/trpc/',
  });

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage());
      return;
    }

    if (url === '/assets/bundle.js' || url.startsWith('/assets/bundle.js?')) {
      try {
        const js = readFileSync(bundlePath());
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(js);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('bundle missing — run pnpm build in @m4trix/trace-viewer');
      }
      return;
    }

    if (url.startsWith('/trpc')) {
      void trpcHandler(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`Trace viewer listening on http://${host}:${port}`);
  });

  return server;
}
