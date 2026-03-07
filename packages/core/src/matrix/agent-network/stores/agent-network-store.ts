export interface AgentNetworkStore<T> {
  storeEvent: (contextId: string, runId: string, event: T) => void;
  getEvents: (contextId: string, runId: string) => Array<T>;
  getContextEvents: (contextId: string) => Map<string, Array<T>>;
  getFullStore: () => Map<string, Map<string, Array<T>>>;
  persist: () => Promise<void>;
  load: () => Promise<void>;
}
