import { asyncNoop } from '../../../helper/types/noop';
import type { AgentNetworkStore } from './agent-network-store';

/**
 * In-memory implementation of AgentNetworkStore. Events are stored in a
 * nested map: contextId -> runId -> events.
 */
export const createInMemoryNetworkStore = <T>(): AgentNetworkStore<T> => {
  const store = new Map<string, Map<string, T[]>>();

  return {
    storeEvent: (contextId: string, runId: string, event: T): void => {
      let byRun = store.get(contextId);
      if (!byRun) {
        byRun = new Map();
        store.set(contextId, byRun);
      }
      let events = byRun.get(runId);
      if (!events) {
        events = [];
        byRun.set(runId, events);
      }
      events.push(event);
    },

    getEvents: (contextId: string, runId: string): T[] => {
      const events = store.get(contextId)?.get(runId);
      return events ? [...events] : [];
    },

    getContextEvents: (contextId: string): Map<string, T[]> => {
      const byRun = store.get(contextId);
      const result = new Map<string, T[]>();
      if (byRun) {
        for (const [runId, events] of byRun) {
          result.set(runId, [...events]);
        }
      }
      return result;
    },

    getFullStore: (): Map<string, Map<string, T[]>> => {
      const result = new Map<string, Map<string, T[]>>();
      for (const [contextId, byRun] of store) {
        const contextMap = new Map<string, T[]>();
        for (const [runId, events] of byRun) {
          contextMap.set(runId, [...events]);
        }
        result.set(contextId, contextMap);
      }
      return result;
    },

    persist: (): Promise<void> => asyncNoop(),
    load: (): Promise<void> => asyncNoop(),
  };
};
