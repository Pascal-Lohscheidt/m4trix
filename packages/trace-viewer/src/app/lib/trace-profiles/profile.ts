import type { ReactNode } from 'react';
import type { RunNode } from '../../types';
import type { PayloadMapping } from '../payload-mapper/mapping-schema';
import type { RunSubtreeRollup } from './langgraph/aggregates';
import type {
  AggregateContext,
  ProfileAggregates,
  ProfileRenderProps,
  TraceProfileId,
} from './types';

export type TraceProfile = {
  id: TraceProfileId;
  kind: 'builtin' | 'custom';
  /** Set for custom profiles: the stored profile id and its current mapping. */
  custom?: { profileId: string; mapping: PayloadMapping };
  label: string;
  description: string;
  /** When true, aggregate panels need every run payload loaded. */
  requiresFullPayloads: boolean;
  /** `raw` is always on and not removable from settings. */
  removable: boolean;
  renderMetadata: (props: ProfileRenderProps) => ReactNode;
  renderInput: (props: ProfileRenderProps) => ReactNode;
  renderOutput: (props: ProfileRenderProps) => ReactNode;
  buildAggregates: (ctx: AggregateContext) => ProfileAggregates;
  /** Per-run subtree token/cost totals shown as badges in the run tree. */
  buildSubtreeRollups?: (
    root: RunNode,
    payloadCache: Record<string, unknown>,
  ) => Map<string, RunSubtreeRollup>;
};
