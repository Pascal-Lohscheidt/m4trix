import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  loadProviderSettings,
  loadStoredKeys,
  type MapperProviderSettings,
  normalizeProviderSettings,
  resolveProviderConfig,
  type StoredKeys,
  saveProviderSettings,
  saveStoredKeys,
} from '../lib/payload-mapper/provider-settings';
import { validateProviderConfig } from '../lib/payload-mapper/providers/catalog';
import type {
  MapperProviderId,
  ProviderConfig,
  ProviderCredentials,
} from '../lib/payload-mapper/providers/types';

type MapperProviderContextValue = {
  settings: MapperProviderSettings;
  updateSettings: (patch: Partial<MapperProviderSettings>) => void;
  setCredentials: (provider: MapperProviderId, credentials: ProviderCredentials) => void;
  /** Resolved config for the selected provider (includes in-memory keys). */
  config: ProviderConfig;
  /** Validation problems for `config`; empty when ready to generate. */
  problems: string[];
};

const MapperProviderContext = createContext<MapperProviderContextValue | null>(null);

export function MapperProviderProvider({ children }: { children: ReactNode }): ReactNode {
  const [settings, setSettings] = useState(() => loadProviderSettings());
  // Keys live in memory; they only touch localStorage when `rememberKeys` is on.
  const [keys, setKeys] = useState<StoredKeys>(() => loadStoredKeys(settings));

  useEffect(() => saveProviderSettings(settings), [settings]);
  useEffect(() => saveStoredKeys(keys, settings.rememberKeys), [keys, settings.rememberKeys]);

  const updateSettings = useCallback((patch: Partial<MapperProviderSettings>) => {
    setSettings((prev) => normalizeProviderSettings({ ...prev, ...patch }));
  }, []);

  const setCredentials = useCallback(
    (provider: MapperProviderId, credentials: ProviderCredentials) => {
      setKeys((prev) => ({ ...prev, [provider]: credentials }));
    },
    [],
  );

  const config = useMemo(() => resolveProviderConfig(settings, keys), [settings, keys]);
  const problems = useMemo(() => validateProviderConfig(config), [config]);

  const value = useMemo<MapperProviderContextValue>(
    () => ({ settings, updateSettings, setCredentials, config, problems }),
    [settings, updateSettings, setCredentials, config, problems],
  );

  return <MapperProviderContext.Provider value={value}>{children}</MapperProviderContext.Provider>;
}

export function useMapperProvider(): MapperProviderContextValue {
  const ctx = useContext(MapperProviderContext);
  if (!ctx) throw new Error('useMapperProvider must be used within MapperProviderProvider');
  return ctx;
}
