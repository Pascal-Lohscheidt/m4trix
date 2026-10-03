import { createContext, type ReactNode, useContext } from 'react';

export type MapperDialogRequest =
  | { mode: 'create' }
  | { mode: 'improve'; profileId: string; pinnedRefs?: string[] };

type MapperDialogContextValue = {
  openMapper: (request: MapperDialogRequest) => void;
};

const MapperDialogContext = createContext<MapperDialogContextValue | null>(null);

export function MapperDialogContextProvider({
  openMapper,
  children,
}: MapperDialogContextValue & { children: ReactNode }): ReactNode {
  return (
    <MapperDialogContext.Provider value={{ openMapper }}>{children}</MapperDialogContext.Provider>
  );
}

/** `null` outside the trace viewer page (e.g. in dialog previews), where no entry points render. */
export function useMapperDialog(): MapperDialogContextValue | null {
  return useContext(MapperDialogContext);
}
