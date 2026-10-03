import type { ReactNode } from 'react';
import { CustomProfilesProvider } from './state/custom-profiles-context';
import { FilterGroupsProvider } from './state/filter-groups-context';
import { MapperProviderProvider } from './state/mapper-provider-context';
import { ViewerSettingsProvider } from './state/viewer-settings-context';

export function AppProviders({ children }: { children: ReactNode }): ReactNode {
  return (
    <CustomProfilesProvider>
      <ViewerSettingsProvider>
        <MapperProviderProvider>
          <FilterGroupsProvider>{children}</FilterGroupsProvider>
        </MapperProviderProvider>
      </ViewerSettingsProvider>
    </CustomProfilesProvider>
  );
}
