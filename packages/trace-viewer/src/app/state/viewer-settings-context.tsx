import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { toTraceProfileId } from '../lib/payload-mapper/profile-store';
import { getTraceProfile, resolveTraceProfiles, type TraceProfile } from '../lib/trace-profiles';
import type { TraceProfileId } from '../lib/trace-profiles/types';
import type { ViewerSettings } from '../lib/viewer-settings';
import {
  ANY_CUSTOM_PROFILE,
  loadViewerSettings,
  normalizeViewerSettings,
  saveViewerSettings,
} from '../lib/viewer-settings';
import { useCustomProfiles } from './custom-profiles-context';

type ViewerSettingsContextValue = {
  settings: ViewerSettings;
  /** Merge patch into current settings and normalize (persisted). */
  updateSettings: (patch: Partial<ViewerSettings>) => void;
  /** Built-in profiles plus one mapped profile per saved custom profile. */
  allProfiles: TraceProfile[];
  activeProfile: TraceProfile;
  profileTabs: { id: TraceProfileId; label: string; kind: TraceProfile['kind'] }[];
  setActiveProfileId: (id: TraceProfileId) => void;
  autoLoad: boolean;
};

const ViewerSettingsContext = createContext<ViewerSettingsContextValue | null>(null);

export function ViewerSettingsProvider({ children }: { children: ReactNode }): ReactNode {
  const { profiles: customProfiles } = useCustomProfiles();

  // Raw state keeps any well-formed custom id so a profile created in the same event as
  // it is activated is not dropped; the effective settings below filter unknown ids.
  const [rawSettings, setRawSettings] = useState<ViewerSettings>(() =>
    loadViewerSettings(ANY_CUSTOM_PROFILE),
  );

  const knownCustomIds = useMemo(
    () => new Set<string>(customProfiles.map((p) => toTraceProfileId(p.id))),
    [customProfiles],
  );

  const settings = useMemo(
    () => normalizeViewerSettings(rawSettings, (id) => knownCustomIds.has(id)),
    [rawSettings, knownCustomIds],
  );

  useEffect(() => {
    saveViewerSettings(settings);
  }, [settings]);

  const updateSettings = useCallback((patch: Partial<ViewerSettings>) => {
    setRawSettings((prev) => normalizeViewerSettings({ ...prev, ...patch }, ANY_CUSTOM_PROFILE));
  }, []);

  const setActiveProfileId = useCallback((id: TraceProfileId) => {
    setRawSettings((prev) =>
      normalizeViewerSettings({ ...prev, activeTraceProfileId: id }, ANY_CUSTOM_PROFILE),
    );
  }, []);

  const allProfiles = useMemo(() => resolveTraceProfiles(customProfiles), [customProfiles]);

  const activeProfile = useMemo(
    () => getTraceProfile(settings.activeTraceProfileId, allProfiles),
    [settings.activeTraceProfileId, allProfiles],
  );

  const profileTabs = useMemo(
    () =>
      settings.enabledTraceProfileIds.map((id) => {
        const profile = getTraceProfile(id, allProfiles);
        return { id, label: profile.label, kind: profile.kind };
      }),
    [settings.enabledTraceProfileIds, allProfiles],
  );

  const value = useMemo<ViewerSettingsContextValue>(
    () => ({
      settings,
      updateSettings,
      allProfiles,
      activeProfile,
      profileTabs,
      setActiveProfileId,
      autoLoad: settings.autoLoad,
    }),
    [settings, updateSettings, allProfiles, activeProfile, profileTabs, setActiveProfileId],
  );

  return <ViewerSettingsContext.Provider value={value}>{children}</ViewerSettingsContext.Provider>;
}

export function useViewerSettings(): ViewerSettingsContextValue {
  const ctx = useContext(ViewerSettingsContext);
  if (!ctx) {
    throw new Error('useViewerSettings must be used within ViewerSettingsProvider');
  }
  return ctx;
}
