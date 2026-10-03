import { z } from 'zod';
import { type PayloadMapping, payloadMappingSchema } from './mapping-schema';
import type { SampleGroup } from './sampling';

export const CUSTOM_PROFILES_STORAGE_KEY = 'm4trix.traceViewer.customProfiles.v1';
export const MAX_PROFILE_VERSIONS = 20;
/** Upper bound for regression samples kept per profile (serialized characters). */
export const MAX_STORED_SAMPLE_CHARS = 200_000;
export const CUSTOM_PROFILE_ID_PREFIX = 'custom:';
export const PROFILE_EXPORT_FORMAT = 'm4trix.traceViewer.profile';

export const profileVersionSourceSchema = z.enum(['generated', 'improved', 'manual', 'imported']);
export type ProfileVersionSource = z.infer<typeof profileVersionSourceSchema>;

const coverageSnapshotSchema = z.object({
  score: z.number(),
  total: z.number(),
  mapped: z.number(),
  partial: z.number(),
  fallback: z.number(),
  unmatched: z.number(),
});

const storedSampleGroupSchema = z.object({
  key: z.string(),
  runType: z.string(),
  runName: z.string(),
  side: z.enum(['input', 'output']),
  samples: z.array(
    z.object({
      traceId: z.string(),
      runId: z.string(),
      ref: z.string(),
      runMetadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      payload: z.unknown(),
    }),
  ),
});

const profileVersionSchema = z.object({
  version: z.number().int().positive(),
  mapping: payloadMappingSchema,
  createdAt: z.string(),
  source: profileVersionSourceSchema,
  provider: z.string().optional(),
  model: z.string().optional(),
  note: z.string().optional(),
  coverage: coverageSnapshotSchema.optional(),
  /** Truncated payload samples for regression checks; only kept on the newest version. */
  samples: z.array(storedSampleGroupSchema).optional(),
});

const customProfileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    currentVersion: z.number().int().positive(),
    versions: z.array(profileVersionSchema).min(1),
  })
  .refine((p) => p.versions.some((v) => v.version === p.currentVersion), {
    message: 'currentVersion must reference an existing version',
  });

export type ProfileVersion = z.infer<typeof profileVersionSchema>;
export type CoverageSnapshot = z.infer<typeof coverageSnapshotSchema>;
export type StoredSampleGroup = z.infer<typeof storedSampleGroupSchema>;
export type CustomProfile = z.infer<typeof customProfileSchema>;
export type CustomProfileStore = { profiles: CustomProfile[] };

export type StoreLoadResult = { store: CustomProfileStore; warnings: string[] };

export function toTraceProfileId(profileId: string): `custom:${string}` {
  return `${CUSTOM_PROFILE_ID_PREFIX}${profileId}`;
}

export function fromTraceProfileId(id: string): string | null {
  return id.startsWith(CUSTOM_PROFILE_ID_PREFIX) ? id.slice(CUSTOM_PROFILE_ID_PREFIX.length) : null;
}

export function currentVersionOf(profile: CustomProfile): ProfileVersion {
  const found = profile.versions.find((v) => v.version === profile.currentVersion);
  // Schema refinement guarantees presence; fall back to newest for safety.
  return found ?? profile.versions[profile.versions.length - 1];
}

export function currentMapping(profile: CustomProfile): PayloadMapping {
  return currentVersionOf(profile).mapping;
}

/** Parse persisted JSON; invalid profiles are dropped with a warning instead of failing the whole store. */
export function parseStore(raw: string | null): StoreLoadResult {
  if (!raw) return { store: { profiles: [] }, warnings: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      store: { profiles: [] },
      warnings: ['Custom profile store is not valid JSON; ignoring it.'],
    };
  }
  const list =
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { profiles?: unknown }).profiles)
      ? (parsed as { profiles: unknown[] }).profiles
      : null;
  if (!list)
    return { store: { profiles: [] }, warnings: ['Custom profile store has no profiles array.'] };

  const warnings: string[] = [];
  const profiles: CustomProfile[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const result = customProfileSchema.safeParse(entry);
    if (!result.success) {
      const name =
        entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string'
          ? (entry as { name: string }).name
          : 'unknown';
      warnings.push(`Skipped invalid custom profile "${name}": ${result.error.issues[0]?.message}`);
      continue;
    }
    if (seen.has(result.data.id)) {
      warnings.push(`Skipped duplicate custom profile id "${result.data.id}".`);
      continue;
    }
    seen.add(result.data.id);
    profiles.push(result.data);
  }
  return { store: { profiles }, warnings };
}

export function serializeStore(store: CustomProfileStore): string {
  return JSON.stringify(store);
}

export function loadCustomProfileStore(): StoreLoadResult {
  if (typeof window === 'undefined') return { store: { profiles: [] }, warnings: [] };
  try {
    return parseStore(window.localStorage.getItem(CUSTOM_PROFILES_STORAGE_KEY));
  } catch {
    return { store: { profiles: [] }, warnings: [] };
  }
}

export function saveCustomProfileStore(store: CustomProfileStore): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CUSTOM_PROFILES_STORAGE_KEY, serializeStore(store));
  } catch {
    // ignore quota / privacy mode errors
  }
}

export function generateProfileId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `p${rand}`;
}

export type VersionMeta = {
  source: ProfileVersionSource;
  provider?: string;
  model?: string;
  note?: string;
  coverage?: CoverageSnapshot;
  samples?: StoredSampleGroup[];
};

function newVersion(
  version: number,
  mapping: PayloadMapping,
  meta: VersionMeta,
  now: string,
): ProfileVersion {
  return { version, mapping, createdAt: now, ...meta };
}

export function createProfile(
  input: { name: string; description?: string; mapping: PayloadMapping } & VersionMeta,
  opts: { id?: string; now?: string } = {},
): CustomProfile {
  const { name, description, mapping, ...meta } = input;
  return {
    id: opts.id ?? generateProfileId(),
    name: name.trim() || 'Untitled profile',
    description,
    currentVersion: 1,
    versions: [newVersion(1, mapping, meta, opts.now ?? new Date().toISOString())],
  };
}

/** Append a new version (it becomes current). Oldest versions beyond the cap are dropped. */
export function appendVersion(
  profile: CustomProfile,
  mapping: PayloadMapping,
  meta: VersionMeta,
  now: string = new Date().toISOString(),
): CustomProfile {
  const nextNumber = Math.max(...profile.versions.map((v) => v.version)) + 1;
  // Regression samples accumulate on the newest version only (older copies are dropped).
  const previousSamples = latestSamples(profile);
  const samples = meta.samples
    ? mergeStoredSamples(previousSamples, meta.samples)
    : previousSamples.length > 0
      ? previousSamples
      : undefined;
  const versions = [
    ...profile.versions.map(({ samples: _drop, ...v }) => v),
    newVersion(nextNumber, mapping, { ...meta, samples }, now),
  ].slice(-MAX_PROFILE_VERSIONS);
  return { ...profile, currentVersion: nextNumber, versions };
}

/** Restoring an old version appends a copy so history stays append-only. */
export function restoreVersion(
  profile: CustomProfile,
  version: number,
  now: string = new Date().toISOString(),
): CustomProfile {
  const target = profile.versions.find((v) => v.version === version);
  if (!target) throw new Error(`Version ${version} not found on profile "${profile.name}"`);
  return appendVersion(
    profile,
    target.mapping,
    { source: 'manual', note: `Restored from v${version}` },
    now,
  );
}

export function duplicateProfile(
  profile: CustomProfile,
  opts: { id?: string; now?: string } = {},
): CustomProfile {
  return createProfile(
    {
      name: `${profile.name} (copy)`,
      description: profile.description,
      mapping: currentMapping(profile),
      source: 'manual',
      note: `Duplicated from "${profile.name}" v${profile.currentVersion}`,
    },
    opts,
  );
}

export type ProfileExport = {
  format: typeof PROFILE_EXPORT_FORMAT;
  name: string;
  description?: string;
  mapping: PayloadMapping;
};

export function exportProfile(profile: CustomProfile): ProfileExport {
  return {
    format: PROFILE_EXPORT_FORMAT,
    name: profile.name,
    description: profile.description,
    mapping: currentMapping(profile),
  };
}

export type ImportResult = { ok: true; profile: CustomProfile } | { ok: false; errors: string[] };

/**
 * Import either an exported profile (`{ format, name, mapping }`) or a bare mapping
 * (`{ schemaVersion: 1, rules }`).
 */
export function importProfile(
  json: string,
  opts: { id?: string; now?: string; fallbackName?: string } = {},
): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { ok: false, errors: [`Invalid JSON: ${(err as Error).message}`] };
  }
  if (!parsed || typeof parsed !== 'object')
    return { ok: false, errors: ['Expected a JSON object.'] };
  const o = parsed as Record<string, unknown>;
  const isExport = o.format === PROFILE_EXPORT_FORMAT;
  const mappingInput = isExport ? o.mapping : o;
  const result = payloadMappingSchema.safeParse(mappingInput);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const name =
    isExport && typeof o.name === 'string' ? o.name : (opts.fallbackName ?? 'Imported profile');
  const description = isExport && typeof o.description === 'string' ? o.description : undefined;
  return {
    ok: true,
    profile: createProfile(
      { name, description, mapping: result.data, source: 'imported' },
      { id: opts.id, now: opts.now },
    ),
  };
}

export function latestSamples(profile: CustomProfile): StoredSampleGroup[] {
  for (let i = profile.versions.length - 1; i >= 0; i--) {
    const samples = profile.versions[i].samples;
    if (samples && samples.length > 0) return samples;
  }
  return [];
}

/** Store-friendly copy of sample groups (truncated payloads only, no originals). */
export function toStoredSamples(groups: SampleGroup[]): StoredSampleGroup[] {
  return groups.map((g) => ({
    key: g.key,
    runType: g.runType,
    runName: g.runName,
    side: g.side,
    samples: g.samples.map((s) => ({
      traceId: s.traceId,
      runId: s.runId,
      ref: s.ref,
      runMetadata: s.runMetadata,
      payload: s.payload,
    })),
  }));
}

/** Rehydrate stored samples as sample groups for regression dry runs. */
export function fromStoredSamples(stored: StoredSampleGroup[]): SampleGroup[] {
  return stored.map((g) => ({
    ...g,
    runCount: g.samples.length,
    shape: '',
    samples: g.samples.map((s) => ({ ...s, payload: s.payload, original: s.payload })),
  }));
}

/**
 * Merge new samples over previous ones (dedupe by ref; newest first) and cap the total size.
 * Every group keeps at least its newest sample while trimming.
 */
export function mergeStoredSamples(
  previous: StoredSampleGroup[],
  next: StoredSampleGroup[],
  maxChars: number = MAX_STORED_SAMPLE_CHARS,
): StoredSampleGroup[] {
  const byKey = new Map<string, StoredSampleGroup>();
  for (const group of [...next, ...previous]) {
    const existing = byKey.get(group.key);
    if (!existing) {
      byKey.set(group.key, { ...group, samples: [...group.samples] });
      continue;
    }
    const seen = new Set(existing.samples.map((s) => s.ref));
    for (const sample of group.samples) if (!seen.has(sample.ref)) existing.samples.push(sample);
  }
  const groups = [...byKey.values()];
  const size = () => JSON.stringify(groups).length;
  while (size() > maxChars) {
    const trimmable = groups.filter((g) => g.samples.length > 1);
    if (trimmable.length === 0) break;
    const largest = trimmable.reduce((a, b) => (a.samples.length >= b.samples.length ? a : b));
    largest.samples.pop();
  }
  while (groups.length > 1 && size() > maxChars) groups.pop();
  return groups;
}
