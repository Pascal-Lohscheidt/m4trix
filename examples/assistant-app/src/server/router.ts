import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import type { AssistantContext } from './context.js';
import { streamAgentEvents } from './stream-bridge.js';

const t = initTRPC.context<AssistantContext>().create({
  jsonl: { pingMs: 1000 },
});

const appRouterImpl = t.router({
  health: t.router({
    ping: t.procedure.query(() => ({ ok: true as const })),
  }),
  chat: t.router({
    send: t.procedure
      .input(
        z.object({
          message: z.string().min(1),
          contextId: z.string().optional(),
        }),
      )
      .mutation(async function* ({ input, ctx }) {
        const contextId = input.contextId ?? crypto.randomUUID();
        const runId = crypto.randomUUID();

        ctx.registerActiveRun(runId, contextId);
        try {
          yield* streamAgentEvents(ctx.exposedApi, {
            message: input.message,
            contextId,
            runId,
          });
        } finally {
          ctx.unregisterActiveRun(runId);
        }
      }),
  }),
  control: t.router({
    resolveCommandApproval: t.procedure
      .input(
        z.object({
          runId: z.string().min(1),
          correlationId: z.string().min(1),
          requestId: z.string().min(1),
          approved: z.boolean(),
          denialReason: z.string().optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        await ctx.publishCommandApprovalResolved(input);
        return { ok: true as const };
      }),
  }),
});

export type AppRouter = typeof appRouterImpl;
export const appRouter = appRouterImpl;
