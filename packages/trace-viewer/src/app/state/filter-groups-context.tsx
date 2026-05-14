import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { FilterGroup } from '../lib/filter-groups';
import { loadFilterGroups, saveFilterGroups } from '../lib/filter-groups';

type FilterGroupsContextValue = {
  filterGroups: FilterGroup[];
  setFilterGroups: Dispatch<SetStateAction<FilterGroup[]>>;
};

const FilterGroupsContext = createContext<FilterGroupsContextValue | null>(null);

export function FilterGroupsProvider({ children }: { children: ReactNode }): ReactNode {
  const [filterGroups, setFilterGroups] = useState<FilterGroup[]>(() => loadFilterGroups());

  useEffect(() => {
    saveFilterGroups(filterGroups);
  }, [filterGroups]);

  const value = useMemo(
    () => ({ filterGroups, setFilterGroups }),
    [filterGroups],
  );

  return <FilterGroupsContext.Provider value={value}>{children}</FilterGroupsContext.Provider>;
}

export function useFilterGroups(): FilterGroupsContextValue {
  const ctx = useContext(FilterGroupsContext);
  if (!ctx) {
    throw new Error('useFilterGroups must be used within FilterGroupsProvider');
  }
  return ctx;
}
