import {
  currentMapping,
  type CustomProfile,
  toTraceProfileId,
} from '../../payload-mapper/profile-store';
import { createMappedDirectUsage } from '../../payload-mapper/usage';
import {
  buildSubtreeRollupsByRunId,
  buildUsageAggregateCards,
  rollupTraceForLanggraph,
} from '../langgraph/aggregates';
import type { TraceProfile } from '../profile';
import { renderMappedMetadata, renderMappedPayload } from './render';

/** Build a trace profile from a saved custom profile's current mapping version. */
export function createMappedProfile(stored: CustomProfile): TraceProfile {
  const mapping = currentMapping(stored);
  const hasUsage = (mapping.usage?.length ?? 0) > 0;
  const directUsage = hasUsage ? createMappedDirectUsage(mapping) : null;
  const ruleCount = mapping.rules.length;

  return {
    id: toTraceProfileId(stored.id),
    kind: 'custom',
    custom: { profileId: stored.id, mapping },
    label: stored.name,
    description:
      stored.description ||
      `${ruleCount} rule${ruleCount === 1 ? '' : 's'} · v${stored.currentVersion}${hasUsage ? ' · token aggregates' : ''}`,
    requiresFullPayloads: hasUsage,
    removable: true,
    renderMetadata: (props) => renderMappedMetadata(mapping, props),
    renderInput: (props) => renderMappedPayload(mapping, 'input', props, stored.id),
    renderOutput: (props) => renderMappedPayload(mapping, 'output', props, stored.id),
    buildSubtreeRollups: directUsage
      ? (root, payloadCache) => buildSubtreeRollupsByRunId(root, payloadCache, directUsage)
      : undefined,
    buildAggregates(ctx) {
      if (!directUsage) return { cards: [] };
      if (!ctx.fullTracePayloadsLoaded)
        return { pendingReason: 'missing_trace_payloads', cards: [] };
      return {
        cards: buildUsageAggregateCards(
          rollupTraceForLanggraph(ctx.root, ctx.payloadCache, directUsage),
        ),
      };
    },
  };
}
