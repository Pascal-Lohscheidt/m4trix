import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TraceViewerApi } from '@m4trix/tracing';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { appRouter } from './router';

/**
 * `import.meta.url` is the emitting file. When this module is bundled into `dist/cli.js`
 * or `dist/index.js`, that directory is `dist/`, and the Vite app lives at `dist/client`.
 * When run as `dist/server/start-server.js`, the client directory is one level up.
 */
function clientDistPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const nextToEmitter = join(here, 'client');
  const fromServerSubdir = join(here, '..', 'client');
  if (existsSync(nextToEmitter)) return nextToEmitter;
  if (existsSync(fromServerSubdir)) return fromServerSubdir;
  return nextToEmitter;
}

function contentType(path: string): string {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

function serveClientAsset(req: http.IncomingMessage, res: http.ServerResponse): void {
  const clientRoot = resolve(clientDistPath());
  const url = new URL(req.url ?? '/', 'http://trace-viewer.local');
  const pathname = decodeURIComponent(url.pathname);
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const candidate = resolve(clientRoot, `.${requestedPath}`);
  const relativePath = relative(clientRoot, candidate);

  if (
    relativePath.startsWith('..') ||
    relativePath === '' ||
    relativePath.split(sep).includes('..')
  ) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  const filePath =
    existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : extname(requestedPath)
        ? null
        : join(clientRoot, 'index.html');

  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  try {
    const body = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    res.end(body);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('client bundle missing; run pnpm --filter @m4trix/trace-viewer build');
  }
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

    if (url.startsWith('/trpc')) {
      void trpcHandler(req, res);
      return;
    }

    serveClientAsset(req, res);
  });

  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`Trace viewer listening on http://${host}:${port}`);
  });

  return server;
}
