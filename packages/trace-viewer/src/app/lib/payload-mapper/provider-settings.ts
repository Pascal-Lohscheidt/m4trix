import { PROVIDER_ORDER, PROVIDERS } from './providers/catalog';
import type {
  MapperProviderId,
  ProviderAuthMode,
  ProviderConfig,
  ProviderCredentials,
} from './providers/types';

/** Non-secret provider choices (never contains keys). */
export const MAPPER_PROVIDER_STORAGE_KEY = 'm4trix.traceViewer.mapperProvider.v1';
/** Only written when the user opts into "Remember keys on this device". */
export const MAPPER_KEYS_STORAGE_KEY = 'm4trix.traceViewer.mapperKeys.v1';

export type MapperProviderSettings = {
  provider: MapperProviderId;
  models: Partial<Record<MapperProviderId, string>>;
  regions: Partial<Record<MapperProviderId, string>>;
  authModes: Partial<Record<MapperProviderId, ProviderAuthMode>>;
  rememberKeys: boolean;
  /** Keep truncated samples with generated profiles for regression checks when improving. */
  keepSamples: boolean;
};

export type StoredKeys = Partial<Record<MapperProviderId, ProviderCredentials>>;

export const DEFAULT_PROVIDER_SETTINGS: MapperProviderSettings = {
  provider: 'anthropic',
  models: {},
  regions: {},
  authModes: {},
  rememberKeys: false,
  keepSamples: true,
};

const isProviderId = (v: unknown): v is MapperProviderId =>
  typeof v === 'string' && (PROVIDER_ORDER as string[]).includes(v);

function stringRecord(value: unknown): Partial<Record<MapperProviderId, string>> {
  const out: Partial<Record<MapperProviderId, string>> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    if (isProviderId(k) && typeof v === 'string') out[k] = v;
  }
  return out;
}

export function normalizeProviderSettings(partial: unknown): MapperProviderSettings {
  const o = partial && typeof partial === 'object' ? (partial as Record<string, unknown>) : {};
  const authModes: Partial<Record<MapperProviderId, ProviderAuthMode>> = {};
  for (const [k, v] of Object.entries(stringRecord(o.authModes))) {
    const id = k as MapperProviderId;
    if ((PROVIDERS[id].authModes as string[]).includes(v)) authModes[id] = v as ProviderAuthMode;
  }
  return {
    provider: isProviderId(o.provider) ? o.provider : DEFAULT_PROVIDER_SETTINGS.provider,
    models: stringRecord(o.models),
    regions: stringRecord(o.regions),
    authModes,
    rememberKeys: o.rememberKeys === true,
    keepSamples: o.keepSamples !== false,
  };
}

const CREDENTIAL_FIELDS: (keyof ProviderCredentials)[] = [
  'apiKey',
  'awsAccessKeyId',
  'awsSecretAccessKey',
  'awsSessionToken',
];

export function normalizeStoredKeys(value: unknown): StoredKeys {
  const out: StoredKeys = {};
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    if (!isProviderId(k) || !v || typeof v !== 'object') continue;
    const creds: ProviderCredentials = {};
    for (const field of CREDENTIAL_FIELDS) {
      const fv = (v as Record<string, unknown>)[field];
      if (typeof fv === 'string' && fv) creds[field] = fv;
    }
    if (Object.keys(creds).length > 0) out[k] = creds;
  }
  return out;
}

export function resolveProviderConfig(
  settings: MapperProviderSettings,
  keys: StoredKeys,
): ProviderConfig {
  const id = settings.provider;
  const info = PROVIDERS[id];
  return {
    provider: id,
    model: (settings.models[id] ?? info.defaultModel).trim(),
    region: info.needsRegion
      ? (settings.regions[id] ?? info.defaultRegion ?? '').trim()
      : undefined,
    authMode: settings.authModes[id] ?? info.authModes[0],
    credentials: keys[id] ?? {},
  };
}

function readJson(key: string): unknown {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function loadProviderSettings(): MapperProviderSettings {
  return normalizeProviderSettings(readJson(MAPPER_PROVIDER_STORAGE_KEY));
}

/** Keys are only read from storage when the user previously opted into remembering them. */
export function loadStoredKeys(settings: MapperProviderSettings): StoredKeys {
  return settings.rememberKeys ? normalizeStoredKeys(readJson(MAPPER_KEYS_STORAGE_KEY)) : {};
}

export function saveProviderSettings(settings: MapperProviderSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MAPPER_PROVIDER_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

/** Persist keys when remembering is on; otherwise make sure none are left on disk. */
export function saveStoredKeys(keys: StoredKeys, remember: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (remember) window.localStorage.setItem(MAPPER_KEYS_STORAGE_KEY, JSON.stringify(keys));
    else window.localStorage.removeItem(MAPPER_KEYS_STORAGE_KEY);
  } catch {
    // ignore
  }
}
