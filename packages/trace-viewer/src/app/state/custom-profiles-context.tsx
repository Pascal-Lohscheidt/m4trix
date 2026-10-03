import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PayloadMapping } from '../lib/payload-mapper/mapping-schema';
import {
  appendVersion,
  CUSTOM_PROFILES_STORAGE_KEY,
  type CustomProfile,
  type CustomProfileStore,
  createProfile as createProfileRecord,
  duplicateProfile as duplicateProfileRecord,
  type ImportResult,
  importProfile,
  loadCustomProfileStore,
  type VersionMeta,
  parseStore,
  restoreVersion as restoreVersionRecord,
  saveCustomProfileStore,
  serializeStore,
} from '../lib/payload-mapper/profile-store';

type CustomProfilesContextValue = {
  profiles: CustomProfile[];
  /** Problems found while loading the persisted store (invalid entries are skipped). */
  warnings: string[];
  createProfile: (
    input: { name: string; description?: string; mapping: PayloadMapping } & VersionMeta,
  ) => CustomProfile;
  saveVersion: (id: string, mapping: PayloadMapping, meta: VersionMeta) => void;
  restoreVersion: (id: string, version: number) => void;
  updateDetails: (id: string, details: { name?: string; description?: string }) => void;
  duplicateProfile: (id: string) => CustomProfile | null;
  removeProfile: (id: string) => void;
  /** Validates and adds the profile on success. */
  importProfileJson: (json: string, fallbackName?: string) => ImportResult;
};

const CustomProfilesContext = createContext<CustomProfilesContextValue | null>(null);

export function CustomProfilesProvider({ children }: { children: ReactNode }): ReactNode {
  const [initial] = useState(() => loadCustomProfileStore());
  const [store, setStore] = useState<CustomProfileStore>(initial.store);
  const [warnings, setWarnings] = useState<string[]>(initial.warnings);
  // Skip writing back a store we just read from another tab.
  const lastSerializedRef = useRef(serializeStore(initial.store));

  useEffect(() => {
    const serialized = serializeStore(store);
    if (serialized === lastSerializedRef.current) return;
    lastSerializedRef.current = serialized;
    saveCustomProfileStore(store);
  }, [store]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== CUSTOM_PROFILES_STORAGE_KEY) return;
      const next = parseStore(event.newValue);
      lastSerializedRef.current = serializeStore(next.store);
      setStore(next.store);
      setWarnings(next.warnings);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const updateProfile = useCallback((id: string, fn: (p: CustomProfile) => CustomProfile) => {
    setStore((prev) => ({ profiles: prev.profiles.map((p) => (p.id === id ? fn(p) : p)) }));
  }, []);

  const createProfile = useCallback<CustomProfilesContextValue['createProfile']>((input) => {
    const profile = createProfileRecord(input);
    setStore((prev) => ({ profiles: [...prev.profiles, profile] }));
    return profile;
  }, []);

  const saveVersion = useCallback<CustomProfilesContextValue['saveVersion']>(
    (id, mapping, meta) => updateProfile(id, (p) => appendVersion(p, mapping, meta)),
    [updateProfile],
  );

  const restoreVersion = useCallback<CustomProfilesContextValue['restoreVersion']>(
    (id, version) => updateProfile(id, (p) => restoreVersionRecord(p, version)),
    [updateProfile],
  );

  const updateDetails = useCallback<CustomProfilesContextValue['updateDetails']>(
    (id, details) =>
      updateProfile(id, (p) => ({
        ...p,
        name: details.name?.trim() || p.name,
        description:
          details.description !== undefined ? details.description || undefined : p.description,
      })),
    [updateProfile],
  );

  const duplicateProfile = useCallback<CustomProfilesContextValue['duplicateProfile']>(
    (id) => {
      const source = store.profiles.find((p) => p.id === id);
      if (!source) return null;
      const copy = duplicateProfileRecord(source);
      setStore((prev) => ({ profiles: [...prev.profiles, copy] }));
      return copy;
    },
    [store.profiles],
  );

  const removeProfile = useCallback((id: string) => {
    setStore((prev) => ({ profiles: prev.profiles.filter((p) => p.id !== id) }));
  }, []);

  const importProfileJson = useCallback<CustomProfilesContextValue['importProfileJson']>(
    (json, fallbackName) => {
      const result = importProfile(json, { fallbackName });
      if (result.ok) setStore((prev) => ({ profiles: [...prev.profiles, result.profile] }));
      return result;
    },
    [],
  );

  const value = useMemo<CustomProfilesContextValue>(
    () => ({
      profiles: store.profiles,
      warnings,
      createProfile,
      saveVersion,
      restoreVersion,
      updateDetails,
      duplicateProfile,
      removeProfile,
      importProfileJson,
    }),
    [
      store.profiles,
      warnings,
      createProfile,
      saveVersion,
      restoreVersion,
      updateDetails,
      duplicateProfile,
      removeProfile,
      importProfileJson,
    ],
  );

  return <CustomProfilesContext.Provider value={value}>{children}</CustomProfilesContext.Provider>;
}

export function useCustomProfiles(): CustomProfilesContextValue {
  const ctx = useContext(CustomProfilesContext);
  if (!ctx) throw new Error('useCustomProfiles must be used within CustomProfilesProvider');
  return ctx;
}
