import { useCallback, useEffect, useMemo, useState } from 'react';
import { client } from '../api/client';
import { getTraceEnv, matchesTraceFilters, uniqueSorted } from '../lib/viewer';
import type { AutoUpdatePreset } from '../lib/viewer-settings';
import { presetToIntervalMs } from '../lib/viewer-settings';
import type { TraceFilters, TraceRow } from '../types';

const defaultFilters: TraceFilters = {
  env: '',
  status: '',
  projectId: '',
  query: '',
};

export function useTraceList(autoUpdatePreset: AutoUpdatePreset) {
  const [traces, setTraces] = useState<TraceRow[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [filters, setFilters] = useState<TraceFilters>(defaultFilters);

  const fetchTraces = useCallback(async () => {
    try {
      const r = await client.traces.list.query({});
      setTraces(r.traces as TraceRow[]);
      setListErr(null);
    } catch (e) {
      setListErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void fetchTraces();
  }, [fetchTraces]);

  useEffect(() => {
    const ms = presetToIntervalMs(autoUpdatePreset);
    if (ms == null) return;
    const id = window.setInterval(() => {
      void fetchTraces();
    }, ms);
    return () => window.clearInterval(id);
  }, [autoUpdatePreset, fetchTraces]);

  const filteredTraces = useMemo(
    () => traces.filter((trace) => matchesTraceFilters(trace, filters)),
    [filters, traces],
  );
  const envOptions = useMemo(() => uniqueSorted(traces.map(getTraceEnv)), [traces]);
  const statusOptions = useMemo(() => uniqueSorted(traces.map((trace) => trace.status)), [traces]);
  const projectOptions = useMemo(
    () => uniqueSorted(traces.map((trace) => trace.projectId ?? '')),
    [traces],
  );

  return {
    traces,
    listErr,
    filters,
    setFilters,
    fetchTraces,
    filteredTraces,
    envOptions,
    statusOptions,
    projectOptions,
  };
}
