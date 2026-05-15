import type { TraceProfile } from '../profile';
import type { AggregateContext } from '../types';
import { rollupTraceForLanggraph } from './aggregates';
import { renderLanggraphInput, renderLanggraphMetadata, renderLanggraphOutput } from './render';

export const langgraphProfile: TraceProfile = {
  id: 'langgraph',
  label: 'LangGraph',
  description: 'Structured LangGraph-style metadata and message summaries; trace-wide token aggregates.',
  requiresFullPayloads: true,
  removable: true,
  renderMetadata: renderLanggraphMetadata,
  renderInput: renderLanggraphInput,
  renderOutput: renderLanggraphOutput,
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
    const cards: { id: string; label: string; value: string }[] = [];
    if (rollup.totalTokens > 0 || rollup.promptTokens > 0 || rollup.completionTokens > 0) {
      cards.push({
        id: 'tokens-total',
        label: 'Tokens (total est.)',
        value: String(rollup.totalTokens || rollup.promptTokens + rollup.completionTokens),
      });
      if (rollup.promptTokens > 0) {
        cards.push({ id: 'tokens-prompt', label: 'Prompt tokens', value: String(rollup.promptTokens) });
      }
      if (rollup.completionTokens > 0) {
        cards.push({
          id: 'tokens-completion',
          label: 'Completion tokens',
          value: String(rollup.completionTokens),
        });
      }
    }
    if (costUsdReported > 0) {
      cards.push({
        id: 'cost-usd-reported',
        label: 'Reported cost (USD)',
        value: costUsdReported.toFixed(6),
      });
    }
    if (costUsdEstimated > 0) {
      cards.push({
        id: 'cost-usd-estimated',
        label: 'Estimated cost (USD)',
        value: `~${costUsdEstimated.toFixed(6)}`,
      });
    }
    if (cards.length === 0 && spansWithUsage === 0) {
      cards.push({
        id: 'no-usage',
        label: 'Usage',
        value: 'No token or cost fields found in loaded payloads.',
      });
    }
    return { cards };
  },
};
