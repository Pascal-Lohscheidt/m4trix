import type { ReactNode } from 'react';
import type { AggregateContext, ProfileAggregates, ProfileRenderProps, TraceProfileId } from './types';

export type TraceProfile = {
  id: TraceProfileId;
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
};
