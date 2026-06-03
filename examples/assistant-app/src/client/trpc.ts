import { createTRPCClient, httpBatchStreamLink } from '@trpc/client';
import type { AppRouter } from '../server/router.js';

export function createAssistantClient(port: number) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchStreamLink({
        url: `http://127.0.0.1:${port}/trpc/`,
      }),
    ],
  });
}

export type AssistantClient = ReturnType<typeof createAssistantClient>;
