import { langgraphProfile } from './langgraph/profile';
import type { TraceProfile } from './profile';
import { rawProfile } from './raw/profile';
import type { TraceProfileId } from './types';

export type { TraceProfile } from './profile';
export type {
  AggregateContext,
  ProfileAggregates,
  ProfileRenderProps,
  TraceProfileId,
} from './types';
export { collectPayloadRefsFromTree, isFullTracePayloadsLoaded } from './types';

export const TRACE_PROFILES: TraceProfile[] = [rawProfile, langgraphProfile];

export const TRACE_PROFILE_BY_ID: Record<TraceProfileId, TraceProfile> = {
  raw: rawProfile,
  langgraph: langgraphProfile,
};

export function getTraceProfile(id: TraceProfileId): TraceProfile {
  return TRACE_PROFILE_BY_ID[id];
}
