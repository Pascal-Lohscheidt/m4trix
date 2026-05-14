import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { getTraceProfile, type TraceProfile } from '../lib/trace-profiles';
import type { TraceProfileId } from '../lib/trace-profiles/types';
import type { ViewerSettings } from '../lib/viewer-settings';
import {
  loadViewerSettings,
  normalizeViewerSettings,
  saveViewerSettings,
} from '../lib/viewer-settings';

type ViewerSettingsContextValue = {
  settings: ViewerSettings;
  /** Merge patch into current settings and normalize (persisted). */
  updateSettings: (patch: Partial<ViewerSettings>) => void;
  activeProfile: TraceProfile;
  profileTabs: { id: TraceProfileId; label: string }[];
  setActiveProfileId: (id: TraceProfileId) => void;
  autoLoad: boolean;
};

const ViewerSettingsContext = createContext<ViewerSettingsContextValue | null>(null);

export function ViewerSettingsProvider({ children }: { children: ReactNode }): ReactNode {
  const [settings, setSettings] = useState<ViewerSettings>(() => loadViewerSettings());

  useEffect(() => {
    saveViewerSettings(settings);
  }, [settings]);

  const updateSettings = useCallback((patch: Partial<ViewerSettings>) => {
    setSettings((prev) => normalizeViewerSettings({ ...prev, ...patch }));
  }, []);

  const setActiveProfileId = useCallback((id: TraceProfileId) => {
    setSettings((prev) => normalizeViewerSettings({ ...prev, activeTraceProfileId: id }));
  }, []);

  const activeProfile = useMemo(
    () => getTraceProfile(settings.activeTraceProfileId),
    [settings.activeTraceProfileId],
  );

  const profileTabs = useMemo(
    () =>
      settings.enabledTraceProfileIds.map((id) => ({
        id,
        label: getTraceProfile(id).label,
      })),
    [settings.enabledTraceProfileIds],
  );

  const value = useMemo<ViewerSettingsContextValue>(
    () => ({
      settings,
      updateSettings,
      activeProfile,
      profileTabs,
      setActiveProfileId,
      autoLoad: settings.autoLoad,
    }),
    [settings, updateSettings, activeProfile, profileTabs, setActiveProfileId],
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
