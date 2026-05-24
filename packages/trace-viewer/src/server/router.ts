import type { TraceViewerApi } from '@m4trix/tracing';
import { initTRPC } from '@trpc/server';
import { z } from 'zod';

export type TraceViewerContext = {
  traceViewerApi: TraceViewerApi;
};

const t = initTRPC.context<TraceViewerContext>().create();

const listInput = z
  .object({
    limit: z.number().int().positive().max(500).optional(),
    cursor: z.string().optional(),
    status: z.enum(['running', 'success', 'error']).optional(),
    projectId: z.string().optional(),
  })
  .optional();

const annotationInput = z.object({
  traceId: z.string().min(1),
  annotation: z.record(z.unknown()),
  merge: z.boolean().optional(),
});

export const appRouter = t.router({
  traces: t.router({
    list: t.procedure.input(listInput).query(async ({ ctx, input }) => {
      return ctx.traceViewerApi.listTraces(input ?? {});
    }),
    getTree: t.procedure
      .input(z.object({ traceId: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        return ctx.traceViewerApi.getTraceTree(input.traceId);
      }),
    getPayload: t.procedure
      .input(z.object({ ref: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        return ctx.traceViewerApi.getPayload<unknown>(input.ref);
      }),
    patchAnnotation: t.procedure.input(annotationInput).mutation(async ({ ctx, input }) => {
      return ctx.traceViewerApi.patchTraceAnnotation(input);
    }),
    patchRunAnnotation: t.procedure
      .input(annotationInput.extend({ runId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        return ctx.traceViewerApi.patchRunAnnotation(input);
      }),
  }),
});

export type AppRouter = typeof appRouter;
