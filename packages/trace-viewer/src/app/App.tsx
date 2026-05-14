import type { ReactNode } from 'react';
import { AppProviders } from './AppProviders';
import { TraceViewerPage } from './TraceViewerPage';

export function App(): ReactNode {
  return (
    <AppProviders>
      <TraceViewerPage />
    </AppProviders>
  );
}
