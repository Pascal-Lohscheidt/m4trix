import type { TraceProfileId } from './trace-profiles/types';

export const VIEWER_SETTINGS_STORAGE_KEY = 'm4trix.traceViewer.settings.v1';

/** Trace list refresh interval; `off` disables polling. */
export type AutoUpdatePreset = 'off' | 's10' | 's20' | 's30' | 'm1' | 'm5' | 'm10';

export type ViewerSettings = {
  autoLoad: boolean;
  autoUpdatePreset: AutoUpdatePreset;
  /** Enabled trace profile views; always includes `raw`. */
  enabledTraceProfileIds: TraceProfileId[];
  /** Which profile is selected in the UI. */
  activeTraceProfileId: TraceProfileId;
};

export const AUTO_UPDATE_PRESETS: {
  value: AutoUpdatePreset;
  label: string;
}[] = [
  { value: 'off', label: 'Off' },
  { value: 's10', label: '10s' },
  { value: 's20', label: '20s' },
  { value: 's30', label: '30s' },
  { value: 'm1', label: '1m' },
  { value: 'm5', label: '5m' },
  { value: 'm10', label: '10m' },
];

const defaultSettings: ViewerSettings = {
  autoLoad: false,
  autoUpdatePreset: 'off',
  enabledTraceProfileIds: ['raw'],
  activeTraceProfileId: 'raw',
};

const KNOWN_PROFILE_IDS = new Set<TraceProfileId>(['raw', 'langgraph']);

export function normalizeViewerSettings(partial: Partial<ViewerSettings>): ViewerSettings {
  const autoLoad = typeof partial.autoLoad === 'boolean' ? partial.autoLoad : defaultSettings.autoLoad;
  const preset = partial.autoUpdatePreset;
  const autoUpdatePreset =
    preset === 'off' ||
    preset === 's10' ||
    preset === 's20' ||
    preset === 's30' ||
    preset === 'm1' ||
    preset === 'm5' ||
    preset === 'm10'
      ? preset
      : defaultSettings.autoUpdatePreset;

  let enabledTraceProfileIds: TraceProfileId[] = Array.isArray(partial.enabledTraceProfileIds)
    ? partial.enabledTraceProfileIds.filter((id): id is TraceProfileId => KNOWN_PROFILE_IDS.has(id))
    : [...defaultSettings.enabledTraceProfileIds];
  if (!enabledTraceProfileIds.includes('raw')) {
    enabledTraceProfileIds = ['raw', ...enabledTraceProfileIds.filter((id) => id !== 'raw')];
  }
  enabledTraceProfileIds = [...new Set(enabledTraceProfileIds)];

  let activeTraceProfileId: TraceProfileId =
    partial.activeTraceProfileId && KNOWN_PROFILE_IDS.has(partial.activeTraceProfileId)
      ? partial.activeTraceProfileId
      : defaultSettings.activeTraceProfileId;
  if (!enabledTraceProfileIds.includes(activeTraceProfileId)) {
    activeTraceProfileId = 'raw';
  }

  return { autoLoad, autoUpdatePreset, enabledTraceProfileIds, activeTraceProfileId };
}

export function presetToIntervalMs(preset: AutoUpdatePreset): number | null {
  switch (preset) {
    case 'off':
      return null;
    case 's10':
      return 10_000;
    case 's20':
      return 20_000;
    case 's30':
      return 30_000;
    case 'm1':
      return 60_000;
    case 'm5':
      return 5 * 60_000;
    case 'm10':
      return 10 * 60_000;
    default:
      return null;
  }
}

export function loadViewerSettings(): ViewerSettings {
  if (typeof window === 'undefined') return { ...defaultSettings };
  try {
    const raw = window.localStorage.getItem(VIEWER_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...defaultSettings };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return { ...defaultSettings };
    const o = parsed as Record<string, unknown>;
    const enabledTraceProfileIds = Array.isArray(o.enabledTraceProfileIds)
      ? o.enabledTraceProfileIds
      : undefined;
    const activeTraceProfileId =
      typeof o.activeTraceProfileId === 'string' ? o.activeTraceProfileId : undefined;
    return normalizeViewerSettings({
      autoLoad: typeof o.autoLoad === 'boolean' ? o.autoLoad : undefined,
      autoUpdatePreset: o.autoUpdatePreset as AutoUpdatePreset | undefined,
      enabledTraceProfileIds: enabledTraceProfileIds as TraceProfileId[] | undefined,
      activeTraceProfileId: activeTraceProfileId as TraceProfileId | undefined,
    });
  } catch {
    return { ...defaultSettings };
  }
}

export function saveViewerSettings(settings: ViewerSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(VIEWER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}
