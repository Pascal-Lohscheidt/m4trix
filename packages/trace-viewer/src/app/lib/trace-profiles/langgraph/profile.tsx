import type { TraceProfile } from '../profile';
import type { AggregateContext } from '../types';
import {
  buildSubtreeRollupsByRunId,
  buildUsageAggregateCards,
  rollupTraceForLanggraph,
} from './aggregates';
import { renderLanggraphInput, renderLanggraphMetadata, renderLanggraphOutput } from './render';

export const langgraphProfile: TraceProfile = {
  id: 'langgraph',
  kind: 'builtin',
  label: 'LangGraph',
  description:
    'Structured LangGraph-style metadata and message summaries; trace-wide token aggregates.',
  requiresFullPayloads: true,
  removable: true,
  renderMetadata: renderLanggraphMetadata,
  renderInput: renderLanggraphInput,
  renderOutput: renderLanggraphOutput,
  buildSubtreeRollups: (root, payloadCache) => buildSubtreeRollupsByRunId(root, payloadCache),
  buildAggregates(ctx: AggregateContext) {
    if (!ctx.fullTracePayloadsLoaded) {
      return {
        pendingReason: 'missing_trace_payloads' as const,
        cards: [],
      };
    }
    const { rollup, costUsdReported, costUsdEstimated, spansWithUsage } = rollupTraceForLanggraph(
      ctx.root,
      ctx.payloadCache,
    );
    const cards = buildUsageAggregateCards({
      rollup,
      costUsdReported,
      costUsdEstimated,
      spansWithUsage,
    });
    return { cards };
  },
};
