import type { CustomProfile } from '../payload-mapper/profile-store';
import { langgraphProfile } from './langgraph/profile';
import { createMappedProfile } from './mapped/profile';
import type { TraceProfile } from './profile';
import { rawProfile } from './raw/profile';
import type { BuiltinTraceProfileId, TraceProfileId } from './types';

export type { TraceProfile } from './profile';
export type {
  AggregateContext,
  BuiltinTraceProfileId,
  ProfileAggregates,
  ProfileRenderProps,
  TraceProfileId,
} from './types';
export {
  collectPayloadRefsFromTree,
  isBuiltinTraceProfileId,
  isFullTracePayloadsLoaded,
} from './types';

export const BUILTIN_TRACE_PROFILES: TraceProfile[] = [rawProfile, langgraphProfile];

export const BUILTIN_TRACE_PROFILE_BY_ID: Record<BuiltinTraceProfileId, TraceProfile> = {
  raw: rawProfile,
  langgraph: langgraphProfile,
};

/** Built-in profiles followed by one mapped profile per saved custom profile. */
export function resolveTraceProfiles(customProfiles: readonly CustomProfile[]): TraceProfile[] {
  return [...BUILTIN_TRACE_PROFILES, ...customProfiles.map(createMappedProfile)];
}

/** Look up a profile by id; unknown ids (e.g. a deleted custom profile) fall back to `raw`. */
export function getTraceProfile(
  id: TraceProfileId,
  profiles: readonly TraceProfile[] = BUILTIN_TRACE_PROFILES,
): TraceProfile {
  return profiles.find((p) => p.id === id) ?? rawProfile;
}
