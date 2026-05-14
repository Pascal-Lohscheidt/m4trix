import type { TraceProfile } from '../profile';
import type { AggregateContext } from '../types';
import { renderRawInput, renderRawMetadata, renderRawOutput } from './render';

export const rawProfile: TraceProfile = {
  id: 'raw',
  label: 'Raw',
  description: 'Unprocessed metadata and JSON payloads.',
  requiresFullPayloads: false,
  removable: false,
  renderMetadata: renderRawMetadata,
  renderInput: renderRawInput,
  renderOutput: renderRawOutput,
  buildAggregates(_ctx: AggregateContext) {
    return { cards: [] };
  },
};
