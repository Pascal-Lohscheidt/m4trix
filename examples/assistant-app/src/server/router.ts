import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { CommandApprovalResolved } from '../network/events.js';
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

        yield* streamAgentEvents(ctx.proxyHandle, {
          message: input.message,
          contextId,
          runId,
        });
      }),
  }),
  control: t.router({
    resolveCommandApproval: t.procedure
      .input(
        z.object({
          runId: z.string().min(1),
          contextId: z.string().min(1),
          correlationId: z.string().min(1),
          requestId: z.string().min(1),
          approved: z.boolean(),
          denialReason: z.string().optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        await ctx.proxyHandle.publish(
          CommandApprovalResolved.make({
            requestId: input.requestId,
            approved: input.approved,
            denialReason: input.denialReason,
          }),
          {
            target: 'channel',
            meta: {
              runId: input.runId,
              contextId: input.contextId,
              correlationId: input.correlationId,
            },
          },
        );
        return { ok: true as const };
      }),
  }),
});

export type AppRouter = typeof appRouterImpl;
export const appRouter = appRouterImpl;
