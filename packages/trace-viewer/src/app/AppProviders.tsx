import type { ReactNode } from 'react';
import { FilterGroupsProvider } from './state/filter-groups-context';
import { ViewerSettingsProvider } from './state/viewer-settings-context';

export function AppProviders({ children }: { children: ReactNode }): ReactNode {
  return (
    <ViewerSettingsProvider>
      <FilterGroupsProvider>{children}</FilterGroupsProvider>
    </ViewerSettingsProvider>
  );
}
