import type { TraceRun } from '@m4trix/tracing';
import { snippetAround } from './json-utils';
import type { IndexedTrace, PayloadSide } from './payload-index';
import { compareRunsByStartTime } from './trace-access';

export type SearchQuery = {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  runType?: string[];
  /** Case-insensitive regex against run names. */
  runName?: string;
  side?: PayloadSide | 'both';
  /** Only leaves whose path starts with this prefix (e.g. `$.messages`). */
  pathPrefix?: string;
};

export type SearchOccurrence = {
  traceId: string;
  run: TraceRun;
  side: PayloadSide;
  path: string;
};

export type SearchHitGroup = {
  /** Snippet around the first match within the leaf value. */
  snippet: string;
  valueLength: number;
  first: SearchOccurrence;
  occurrences: SearchOccurrence[];
};

export type SearchResult = {
  groups: SearchHitGroup[];
  totalOccurrences: number;
  searchedPayloads: number;
};

export function compileSearchPattern(query: SearchQuery): RegExp {
  const flags = query.caseSensitive ? '' : 'i';
  const source = query.regex ? query.query : query.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(source, flags);
}

/**
 * Searches loaded payload leaves. Identical leaf values are grouped so a message that is
 * repeated in every LangGraph state snapshot shows up once, attributed to the run where it
 * first appeared (inputs at run start, outputs at run end).
 */
export function searchPayloads(traces: IndexedTrace[], query: SearchQuery): SearchResult {
  const pattern = compileSearchPattern(query);
  const runNamePattern = query.runName ? new RegExp(query.runName, 'i') : null;
  const runTypes = query.runType?.length ? new Set(query.runType) : null;
  const side = query.side ?? 'both';

  const groups = new Map<string, SearchHitGroup>();
  let totalOccurrences = 0;
  let searchedPayloads = 0;

  for (const entry of traces) {
    // Inputs exist from run start, outputs only from run end: ordering by that moment
    // attributes a value to the run that produced it, not to an ancestor that echoes it.
    const payloads = [...entry.payloads.values()]
      .map((payload) => {
        const run = entry.runs.get(payload.runId);
        const at =
          run && payload.side === 'output' ? (run.endTime ?? run.startTime) : run?.startTime;
        return { payload, run, at: at ?? '' };
      })
      .filter(
        (item): item is { payload: typeof item.payload; run: TraceRun; at: string } =>
          item.run !== undefined,
      )
      .sort(
        (left, right) =>
          left.at.localeCompare(right.at) ||
          (left.payload.side === right.payload.side ? 0 : left.payload.side === 'input' ? -1 : 1) ||
          compareRunsByStartTime(left.run, right.run),
      );

    for (const { payload, run } of payloads) {
      if (side !== 'both' && payload.side !== side) continue;
      if (runTypes && !runTypes.has(run.type)) continue;
      if (runNamePattern && !runNamePattern.test(run.name)) continue;
      searchedPayloads += 1;

      for (const leaf of payload.leaves) {
        if (query.pathPrefix && !leaf.path.startsWith(query.pathPrefix)) continue;
        const match = pattern.exec(leaf.text);
        if (!match) continue;

        totalOccurrences += 1;
        const occurrence: SearchOccurrence = {
          traceId: entry.trace.traceId,
          run,
          side: payload.side,
          path: leaf.path,
        };
        const group = groups.get(leaf.text);
        if (group) {
          group.occurrences.push(occurrence);
          continue;
        }
        groups.set(leaf.text, {
          snippet: snippetAround(leaf.text, match.index, match[0].length),
          valueLength: leaf.text.length,
          first: occurrence,
          occurrences: [occurrence],
        });
      }
    }
  }

  return { groups: [...groups.values()], totalOccurrences, searchedPayloads };
}
