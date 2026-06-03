import http from 'node:http';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { logInfo } from '../logging.js';
import type { AssistantContext } from './context.js';
import { appRouter } from './router.js';

export type StartServerOptions = {
  context: AssistantContext;
  port: number;
  host?: string;
};

export function startAssistantServer(options: StartServerOptions): http.Server {
  const { context, port, host = '127.0.0.1' } = options;

  const trpcHandler = createHTTPHandler({
    router: appRouter,
    createContext: (): AssistantContext => context,
    basePath: '/trpc/',
  });

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';

    if (url.startsWith('/trpc')) {
      void trpcHandler(req, res);
      return;
    }

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  server.listen(port, host, () => {
    logInfo(`Assistant server listening on http://${host}:${port}`);
  });

  return server;
}
