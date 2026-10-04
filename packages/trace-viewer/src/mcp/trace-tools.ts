import type { Trace, TraceRecord, TraceRun, TraceViewerApi } from '@m4trix/tracing';
import { analyzeTrace } from './analyze';
import { extractMessageSequences, formatMessages } from './conversation';
import { diffJson, formatJsonChanges } from './diff';
import {
  decodeJsonStrings,
  evaluateWithPaths,
  outlinePayload,
  previewPayload,
  safeStringify,
  truncate,
} from './json-utils';
import {
  type LoadTraceResult,
  PayloadIndex,
  type PayloadIndexOptions,
  type PayloadSide,
} from './payload-index';
import {
  type RunFilter,
  runMatchesFilter,
  type TraceFilter,
  traceMatchesFilter,
} from './run-query';
import { type SearchQuery, searchPayloads } from './search';
import {
  buildRunForest,
  formatMetadata,
  formatMs,
  formatRunLabel,
  formatTokens,
  formatTraceRow,
  MAX_TRACE_SCAN,
  type RunTreeNode,
  resolveRun,
  resolveTrace,
  runAncestry,
  scanTraces,
  shortId,
  TraceToolError,
  walkForest,
} from './trace-access';
import { DEFAULT_HIDE_PATTERN, renderTreeOutline } from './tree-outline';

const MAX_AUTO_LOAD_TRACES = 20;

function compileUserRegex(pattern: string, label: string, flags = 'i'): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new TraceToolError(
      `Invalid ${label} regex: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export type ListTracesInput = TraceFilter & {
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
};

export type GetTraceInput = {
  traceId: string;
  focusRunId?: string;
  maxDepth?: number;
  maxNodes?: number;
  hide?: string;
};

export type FindRunsInput = RunFilter & {
  traceIds?: string[];
  traceLimit?: number;
  limit?: number;
};

export type GetRunInput = { traceId: string; runId: string; previewChars?: number };

export type GetPayloadInput = {
  ref?: string;
  traceId?: string;
  runId?: string;
  side?: PayloadSide;
  path?: string;
  mode?: 'auto' | 'json' | 'outline';
  offset?: number;
  maxChars?: number;
  outlineDepth?: number;
};

export type LoadPayloadsInput = {
  traceIds?: string[];
  status?: Trace['status'];
  projectId?: string;
  limit?: number;
};

export type SearchPayloadsInput = SearchQuery & {
  traceIds?: string[];
  maxGroups?: number;
  offset?: number;
  maxOccurrencesPerGroup?: number;
};

export type AnalyzeTraceInput = { traceId: string; loadPayloads?: boolean };

export type GetConversationInput = {
  traceId: string;
  runId: string;
  side?: PayloadSide | 'both';
  maxMessages?: number;
  maxCharsPerMessage?: number;
};

export type CompareTarget = { traceId: string; runId?: string };
export type CompareInput = {
  a: CompareTarget;
  b: CompareTarget;
  side?: PayloadSide | 'both';
  maxChanges?: number;
};

export type AnnotateInput = {
  traceId: string;
  runId?: string;
  annotation: Record<string, unknown>;
  merge?: boolean;
};

/**
 * Implementation behind the MCP tools. Every method returns plain text sized for an agent's
 * context window and throws `TraceToolError` for user-correctable problems.
 */
export class TraceTools {
  readonly index: PayloadIndex;

  constructor(
    private readonly api: TraceViewerApi,
    options: { index?: PayloadIndexOptions } = {},
  ) {
    this.index = new PayloadIndex(api, options.index);
  }

  async listTraces(input: ListTracesInput): Promise<string> {
    const limit = input.limit ?? 20;
    const offset = input.offset ?? 0;
    const namePattern = input.name ? compileUserRegex(input.name, 'name') : null;
    const matches: Trace[] = [];
    const { scanned, exhausted } = await scanTraces(
      this.api,
      {
        ...(input.status ? { status: input.status } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.since ? { startAfter: input.since } : {}),
        ...(input.until ? { startBefore: input.until } : {}),
      },
      (trace) => {
        if (traceMatchesFilter(trace, input, namePattern)) matches.push(trace);
        return matches.length <= offset + limit;
      },
    );

    const page = matches.slice(offset, offset + limit);
    if (page.length === 0) {
      return offset > 0 ? `No traces at offset ${offset}.` : 'No traces match.';
    }
    const hasMore = matches.length > offset + limit;
    const lines = page.map((trace) => {
      const loaded = this.index.get(trace.traceId) ? '  [payloads loaded]' : '';
      return `${formatTraceRow(trace)}${loaded}`;
    });
    const footer = hasMore
      ? `More traces available: call again with offset=${offset + limit}.`
      : !exhausted && scanned >= MAX_TRACE_SCAN
        ? `Scan stopped after ${MAX_TRACE_SCAN} traces; narrow with since/until/status.`
        : '';
    return [`${plural(page.length, 'trace')} (newest first, offset ${offset}):`, ...lines, footer]
      .filter(Boolean)
      .join('\n');
  }

  async getTrace(input: GetTraceInput): Promise<string> {
    const record = await resolveTrace(this.api, input.traceId);
    const forest = buildRunForest(record);
    const hide = input.hide === undefined ? DEFAULT_HIDE_PATTERN : input.hide;
    const hidePattern = hide ? compileUserRegex(hide, 'hide', '') : null;

    let roots = forest.roots;
    let focusLine = '';
    if (input.focusRunId) {
      const run = resolveRun(record, input.focusRunId);
      const node = forest.byId.get(run.runId) as RunTreeNode;
      roots = [node];
      focusLine = `focus: ${runAncestry(forest, run.runId)
        .map((ancestor) => ancestor.name)
        .join(' › ')}`;
    }

    const outline = renderTreeOutline(roots, {
      hide: hidePattern,
      maxDepth: input.maxDepth,
      maxNodes: input.maxNodes,
    });
    const notes = [
      outline.hidden > 0
        ? `${plural(outline.hidden, 'run')} hidden by pattern /${hide}/ (pass hide: "" to show all)`
        : '',
      forest.orphanRunIds.length > 0
        ? `${plural(forest.orphanRunIds.length, 'orphan run')} shown as extra roots`
        : '',
      this.index.get(record.trace.traceId) ? 'payloads loaded' : '',
    ].filter(Boolean);

    const header = [
      formatTraceRow(record.trace),
      record.trace.annotation
        ? `annotation: ${truncate(safeStringify(record.trace.annotation), 600)}`
        : '',
      focusLine,
      notes.length > 0 ? `(${notes.join('; ')})` : '',
    ].filter(Boolean);
    return `${header.join('\n')}\n\n${outline.text}`;
  }

  async findRuns(input: FindRunsInput): Promise<string> {
    const limit = input.limit ?? 50;
    const namePattern = input.name ? compileUserRegex(input.name, 'name') : null;
    const records = await this.resolveTraceScope(input.traceIds, input.traceLimit ?? 20);

    const sections: string[] = [];
    let total = 0;
    let shown = 0;
    for (const record of records) {
      const forest = buildRunForest(record);
      const lines: string[] = [];
      walkForest(forest, (node) => {
        if (!runMatchesFilter(node, input, namePattern)) return;
        total += 1;
        if (shown >= limit) return;
        shown += 1;
        const parent = node.parentRunId ? forest.byId.get(node.parentRunId) : undefined;
        lines.push(
          `- ${formatRunLabel(node)}  depth ${node.depth}${parent ? `  parent ${parent.name}` : ''}`,
        );
      });
      if (lines.length > 0) {
        sections.push(
          `trace ${record.trace.traceId} "${record.trace.name}" (${record.trace.status})\n${lines.join('\n')}`,
        );
      }
    }

    if (total === 0) return `No runs match in ${plural(records.length, 'trace')}.`;
    const footer =
      total > shown ? `\n${total - shown} more matches; raise limit or narrow the filter.` : '';
    return `${plural(total, 'matching run')} in ${plural(records.length, 'searched trace')}:\n\n${sections.join('\n\n')}${footer}`;
  }

  async getRun(input: GetRunInput): Promise<string> {
    const previewChars = input.previewChars ?? 1500;
    const record = await resolveTrace(this.api, input.traceId);
    const run = resolveRun(record, input.runId);
    const forest = buildRunForest(record);
    const node = forest.byId.get(run.runId) as RunTreeNode;

    const lines = [
      formatRunLabel(run, { errorChars: 0 }),
      `runId: ${run.runId}`,
      `traceId: ${run.traceId}`,
      `path: ${runAncestry(forest, run.runId)
        .map((ancestor) => ancestor.name)
        .join(' › ')}`,
      `time: ${run.startTime} → ${run.endTime ?? '(not ended)'}${run.latencyMs !== undefined ? ` (${formatMs(run.latencyMs)})` : ''}`,
      run.tokens ? `tokens: ${formatTokens(run.tokens)}` : '',
      run.costUsd !== undefined ? `cost: $${run.costUsd}` : '',
      run.error ? `error: ${run.error.type ? `${run.error.type}: ` : ''}${run.error.message}` : '',
      run.metadata ? `metadata: ${formatMetadata(run.metadata, 50)}` : '',
      run.annotation ? `annotation: ${truncate(safeStringify(run.annotation), 1000)}` : '',
      run.extra ? `extra: ${truncate(safeStringify(run.extra), 600)}` : '',
    ];

    if (node.children.length > 0) {
      lines.push(`children (${node.children.length}):`);
      for (const child of node.children.slice(0, 30)) lines.push(`  ${formatRunLabel(child)}`);
      if (node.children.length > 30) lines.push(`  … ${node.children.length - 30} more`);
    }

    for (const side of ['input', 'output'] as const) {
      const ref = side === 'input' ? run.inputRef : run.outputRef;
      if (!ref) {
        lines.push(`${side}: (none)`);
        continue;
      }
      try {
        const value = await this.loadPayloadValue(record.trace.traceId, ref);
        lines.push(`${side}: ${previewPayload(value, previewChars)}`);
      } catch (error) {
        lines.push(
          `${side}: failed to load ${ref}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return lines.filter(Boolean).join('\n');
  }

  async getPayload(input: GetPayloadInput): Promise<string> {
    const maxChars = input.maxChars ?? 12_000;
    const offset = input.offset ?? 0;
    const mode = input.mode ?? 'auto';
    const { ref, traceId, label } = await this.resolvePayloadRef(input);
    const value = await this.loadPayloadValue(traceId, ref);

    let target: unknown = value;
    let targetPath = '$';
    if (input.path && input.path.trim() !== '$') {
      const result = evaluateWithPaths(value, input.path);
      if (!result.ok) throw new TraceToolError(result.error);
      if (result.matches.length === 0) {
        return `${label}\nPath ${input.path} matched nothing. Top-level structure:\n${outlinePayload(value, '$', { maxDepth: 1 })}`;
      }
      if (result.matches.length === 1) {
        target = result.matches[0].value;
        targetPath = result.matches[0].path;
      } else {
        const listed = result.matches
          .slice(0, 50)
          .map((match) => `${match.path}: ${previewPayload(match.value, 300)}`);
        const more =
          result.matches.length > 50 ? `\n… ${result.matches.length - 50} more matches` : '';
        return truncate(
          `${label}\n${result.matches.length} matches for ${input.path}:\n${listed.join('\n')}${more}`,
          maxChars,
        );
      }
    }

    const header = `${label}${targetPath !== '$' ? ` at ${targetPath}` : ''}`;
    if (mode === 'outline') {
      return `${header}\n${outlinePayload(target, targetPath, { maxDepth: input.outlineDepth ?? 4 })}`;
    }

    const body = typeof target === 'string' ? target : safeStringify(target, 2);
    if (mode === 'auto' && offset === 0 && body.length > maxChars) {
      return `${header} — ${body.length} chars, too large for one response. Outline below; fetch parts with \`path\`, or use mode "json" with offset to page.\n${outlinePayload(target, targetPath, { maxDepth: input.outlineDepth ?? 4 })}`;
    }
    const slice = body.slice(offset, offset + maxChars);
    const end = offset + slice.length;
    const footer =
      end < body.length
        ? `\n… [chars ${offset}–${end} of ${body.length}; continue with offset=${end}]`
        : '';
    const range = offset > 0 ? ` (from char ${offset})` : '';
    return `${header}${range}\n${slice}${footer}`;
  }

  async loadTracePayloads(input: LoadPayloadsInput): Promise<string> {
    const records = await this.resolveTraceScope(input.traceIds, input.limit ?? 10, {
      ...(input.status ? { status: input.status } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    });
    if (records.length === 0) return 'No traces to load.';

    const results: LoadTraceResult[] = [];
    for (const record of records) results.push(await this.index.loadTrace(record));

    const lines = results.map((result) => {
      const failed =
        result.failed.length > 0
          ? `, ${result.failed.length} failed (${result.failed[0].message})`
          : '';
      return `- ${result.traceId} "${result.traceName}" (${result.status}): ${result.loaded} loaded, ${result.alreadyLoaded} cached${failed}, ${Math.round(result.size / 1024)} KB`;
    });
    const evicted = results.flatMap((result) => result.evicted);
    if (evicted.length > 0)
      lines.push(`evicted to stay within memory budget: ${evicted.map(shortId).join(', ')}`);
    lines.push(
      `index: ${plural(this.index.loadedTraces().length, 'trace')}, ${Math.round(this.index.totalSize() / 1024)} KB. Use search_payloads to search them.`,
    );
    return lines.join('\n');
  }

  async searchPayloads(input: SearchPayloadsInput): Promise<string> {
    if (!input.query) throw new TraceToolError('query must not be empty.');
    if (input.regex) compileUserRegex(input.query, 'query');
    if (input.runName) compileUserRegex(input.runName, 'runName');

    let scope = this.index.loadedTraces();
    let loadNote = '';
    if (input.traceIds && input.traceIds.length > 0) {
      if (input.traceIds.length > MAX_AUTO_LOAD_TRACES) {
        throw new TraceToolError(`Pass at most ${MAX_AUTO_LOAD_TRACES} traceIds per search.`);
      }
      const records = await this.resolveTraceScope(input.traceIds, MAX_AUTO_LOAD_TRACES);
      for (const record of records) {
        if (!this.index.isFullyLoaded(record)) await this.index.loadTrace(record);
      }
      scope = records
        .map((record) => this.index.get(record.trace.traceId))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    } else if (scope.length === 0) {
      return 'No payloads loaded yet. Call load_trace_payloads first, or pass traceIds (e.g. ["latest"]) to load and search specific traces.';
    } else {
      loadNote = ` (all ${plural(scope.length, 'loaded trace')}; other traces are not searched)`;
    }

    const result = searchPayloads(scope, input);
    const failures = scope.reduce((sum, entry) => sum + entry.failures.length, 0);
    const failureNote =
      failures > 0
        ? `\nwarning: ${plural(failures, 'payload')} failed to load and were not searched.`
        : '';
    if (result.groups.length === 0) {
      return `No matches in ${plural(result.searchedPayloads, 'payload')} across ${plural(scope.length, 'trace')}${loadNote}.${failureNote}`;
    }

    const maxGroups = input.maxGroups ?? 30;
    const offset = input.offset ?? 0;
    const perGroup = input.maxOccurrencesPerGroup ?? 5;
    const page = result.groups.slice(offset, offset + maxGroups);
    const blocks = page.map((group, index) => {
      const { first } = group;
      const parents = this.index.get(first.traceId)?.runs;
      const lines = [
        `[${offset + index + 1}] "${group.snippet}" (${group.valueLength} chars, ${group.occurrences.length}×)`,
        `    first: trace ${shortId(first.traceId)} · ${first.run.type} ${first.run.name} [${shortId(first.run.runId)}] · ${first.side} ${first.path}`,
        `           in ${ancestryLabel(first.run, parents)}`,
      ];
      const rest = group.occurrences.slice(1);
      for (const occurrence of rest.slice(0, perGroup)) {
        lines.push(
          `    also:  trace ${shortId(occurrence.traceId)} · ${occurrence.run.type} ${occurrence.run.name} [${shortId(occurrence.run.runId)}] · ${occurrence.side} ${occurrence.path}`,
        );
      }
      if (rest.length > perGroup) lines.push(`    … ${rest.length - perGroup} more occurrences`);
      return lines.join('\n');
    });

    const more =
      result.groups.length > offset + maxGroups
        ? `\n${result.groups.length - offset - maxGroups} more distinct values; continue with offset=${offset + maxGroups}.`
        : '';
    return `${plural(result.groups.length, 'distinct matching value')} (${plural(result.totalOccurrences, 'occurrence')}) in ${plural(result.searchedPayloads, 'payload')} across ${plural(scope.length, 'trace')}${loadNote}:\n\n${blocks.join('\n')}${more}${failureNote}`;
  }

  async analyzeTrace(input: AnalyzeTraceInput): Promise<string> {
    const record = await resolveTrace(this.api, input.traceId);
    if (input.loadPayloads ?? true) await this.index.loadTrace(record);
    const indexed = this.index.isFullyLoaded(record)
      ? this.index.get(record.trace.traceId)
      : undefined;
    return analyzeTrace(record, buildRunForest(record), indexed);
  }

  async getConversation(input: GetConversationInput): Promise<string> {
    const record = await resolveTrace(this.api, input.traceId);
    const run = resolveRun(record, input.runId);
    const sides: PayloadSide[] =
      input.side === 'input'
        ? ['input']
        : input.side === 'output'
          ? ['output']
          : ['input', 'output'];
    const maxMessages = input.maxMessages ?? 100;

    const blocks: string[] = [formatRunLabel(run)];
    let found = 0;
    for (const side of sides) {
      const ref = side === 'input' ? run.inputRef : run.outputRef;
      if (!ref) continue;
      const value = await this.loadPayloadValue(record.trace.traceId, ref);
      for (const sequence of extractMessageSequences(value)) {
        found += 1;
        const { messages } = sequence;
        const skipped = Math.max(0, messages.length - maxMessages);
        const shown = messages.slice(skipped);
        const header = `[${side} ${sequence.path}] ${plural(messages.length, 'message')}${skipped > 0 ? ` (first ${skipped} omitted)` : ''}`;
        const formatted = formatMessages(shown, { maxCharsPerMessage: input.maxCharsPerMessage });
        blocks.push(`${header}\n${skipped > 0 ? renumber(formatted, skipped) : formatted}`);
      }
    }
    if (found === 0) {
      blocks.push(
        'No chat messages recognized in this run. Use get_payload with mode "outline" to inspect its structure.',
      );
    }
    return blocks.join('\n\n');
  }

  async compare(input: CompareInput): Promise<string> {
    const recordA = await resolveTrace(this.api, input.a.traceId);
    const recordB = await resolveTrace(this.api, input.b.traceId);
    if (Boolean(input.a.runId) !== Boolean(input.b.runId)) {
      throw new TraceToolError(
        'Pass runId for both sides (run comparison) or for neither (trace comparison).',
      );
    }
    if (input.a.runId && input.b.runId) {
      return this.compareRuns(
        recordA,
        resolveRun(recordA, input.a.runId),
        recordB,
        resolveRun(recordB, input.b.runId),
        input,
      );
    }
    return compareTraceStructure(recordA, recordB);
  }

  async annotate(input: AnnotateInput): Promise<string> {
    const record = await resolveTrace(this.api, input.traceId);
    const merge = input.merge ?? true;
    if (input.runId) {
      const run = resolveRun(record, input.runId);
      const updated = await this.api.patchRunAnnotation({
        traceId: record.trace.traceId,
        runId: run.runId,
        annotation: input.annotation,
        merge,
      });
      if (!updated) throw new TraceToolError(`Run ${run.runId} could not be annotated.`);
      return `Annotated run ${updated.runId} (${updated.name}): ${safeStringify(updated.annotation ?? {})}`;
    }
    const updated = await this.api.patchTraceAnnotation({
      traceId: record.trace.traceId,
      annotation: input.annotation,
      merge,
    });
    if (!updated) throw new TraceToolError(`Trace ${record.trace.traceId} could not be annotated.`);
    return `Annotated trace ${updated.traceId} (${updated.name}): ${safeStringify(updated.annotation ?? {})}`;
  }

  private async compareRuns(
    recordA: TraceRecord,
    runA: TraceRun,
    recordB: TraceRecord,
    runB: TraceRun,
    input: CompareInput,
  ): Promise<string> {
    const maxChanges = input.maxChanges ?? 100;
    const lines = [
      `A: ${formatRunLabel(runA)} (trace ${shortId(runA.traceId)})`,
      `B: ${formatRunLabel(runB)} (trace ${shortId(runB.traceId)})`,
    ];

    const fields: (keyof TraceRun)[] = [
      'type',
      'name',
      'status',
      'latencyMs',
      'tokens',
      'costUsd',
      'error',
      'metadata',
    ];
    const fieldChanges = fields
      .filter((field) => safeStringify(runA[field]) !== safeStringify(runB[field]))
      .map(
        (field) =>
          `~ ${field}: ${truncate(safeStringify(runA[field]) ?? 'undefined', 200)} → ${truncate(safeStringify(runB[field]) ?? 'undefined', 200)}`,
      );
    lines.push(
      '',
      fieldChanges.length > 0 ? `run fields:\n${fieldChanges.join('\n')}` : 'run fields: identical',
    );

    const sides: PayloadSide[] =
      input.side === 'input'
        ? ['input']
        : input.side === 'output'
          ? ['output']
          : ['input', 'output'];
    for (const side of sides) {
      const refA = side === 'input' ? runA.inputRef : runA.outputRef;
      const refB = side === 'input' ? runB.inputRef : runB.outputRef;
      if (!refA && !refB) continue;
      const valueA = refA ? await this.loadPayloadValue(recordA.trace.traceId, refA) : undefined;
      const valueB = refB ? await this.loadPayloadValue(recordB.trace.traceId, refB) : undefined;
      const { changes, truncated } = diffJson(valueA, valueB, maxChanges);
      lines.push(
        '',
        changes.length === 0
          ? `${side}: identical`
          : `${side}: ${plural(changes.length, 'change')}${truncated ? ' (truncated; raise maxChanges or compare narrower runs)' : ''}\n${formatJsonChanges(changes)}`,
      );
    }
    return lines.join('\n');
  }

  private async resolveTraceScope(
    traceIds: string[] | undefined,
    limit: number,
    query: { status?: Trace['status']; projectId?: string } = {},
  ): Promise<TraceRecord[]> {
    if (traceIds && traceIds.length > 0) {
      const records: TraceRecord[] = [];
      const seen = new Set<string>();
      for (const traceId of traceIds) {
        const record = await resolveTrace(this.api, traceId);
        if (seen.has(record.trace.traceId)) continue;
        seen.add(record.trace.traceId);
        records.push(record);
      }
      return records;
    }

    const traceIdsToLoad: string[] = [];
    await scanTraces(this.api, query, (trace) => {
      traceIdsToLoad.push(trace.traceId);
      return traceIdsToLoad.length < limit;
    });
    const records = await Promise.all(traceIdsToLoad.map((traceId) => this.api.getTrace(traceId)));
    return records.filter((record): record is TraceRecord => record !== null);
  }

  private async resolvePayloadRef(
    input: GetPayloadInput,
  ): Promise<{ ref: string; traceId: string | undefined; label: string }> {
    if (input.ref) return { ref: input.ref, traceId: undefined, label: `payload ${input.ref}` };
    if (!input.traceId || !input.runId) {
      throw new TraceToolError('Pass either ref, or traceId + runId (+ side).');
    }
    const record = await resolveTrace(this.api, input.traceId);
    const run = resolveRun(record, input.runId);
    const side = input.side ?? 'output';
    const ref = side === 'input' ? run.inputRef : run.outputRef;
    if (!ref) {
      throw new TraceToolError(
        `Run ${run.runId} (${run.name}) has no ${side} payload${run.status === 'running' ? ' yet (still running)' : ''}.`,
      );
    }
    return {
      ref,
      traceId: record.trace.traceId,
      label: `${side} of ${run.type} ${run.name} [${shortId(run.runId)}]`,
    };
  }

  /** Decoded payload from the index when loaded, otherwise fetched directly (not cached). */
  private async loadPayloadValue(traceId: string | undefined, ref: string): Promise<unknown> {
    if (traceId) {
      const cached = this.index.getPayload(traceId, ref);
      if (cached) return cached.value;
    } else {
      for (const entry of this.index.loadedTraces()) {
        const cached = entry.payloads.get(ref);
        if (cached) return cached.value;
      }
    }
    try {
      return decodeJsonStrings(await this.api.getPayload<unknown>(ref));
    } catch (error) {
      throw new TraceToolError(
        `Failed to load payload ${ref}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Up to three ancestor names, so plumbing runs (e.g. ChannelWrite) show the node that owns them. */
function ancestryLabel(run: TraceRun, runs: Map<string, TraceRun> | undefined): string {
  const names: string[] = [];
  let current = run.parentRunId ? runs?.get(run.parentRunId) : undefined;
  while (current && names.length < 3) {
    names.unshift(current.name);
    current = current.parentRunId ? runs?.get(current.parentRunId) : undefined;
  }
  if (names.length === 0) return '(trace root)';
  return `${current ? '… › ' : ''}${names.join(' › ')}`;
}

function renumber(formatted: string, offset: number): string {
  return formatted.replace(/^#(\d+) /gm, (_, index: string) => `#${Number(index) + offset} `);
}

/** Aligns runs by type, name and occurrence order, then reports structural differences. */
function compareTraceStructure(recordA: TraceRecord, recordB: TraceRecord): string {
  const keyed = (record: TraceRecord): Map<string, RunTreeNode> => {
    const forest = buildRunForest(record);
    const counts = new Map<string, number>();
    const byKey = new Map<string, RunTreeNode>();
    walkForest(forest, (node) => {
      const base = `${node.type} ${node.name}`;
      const occurrence = counts.get(base) ?? 0;
      counts.set(base, occurrence + 1);
      byKey.set(`${base} #${occurrence + 1}`, node);
    });
    return byKey;
  };
  const runsA = keyed(recordA);
  const runsB = keyed(recordB);

  const onlyA = [...runsA.keys()].filter((key) => !runsB.has(key));
  const onlyB = [...runsB.keys()].filter((key) => !runsA.has(key));
  const statusChanges: string[] = [];
  const latencyChanges: string[] = [];
  const tokenChanges: string[] = [];
  for (const [key, runA] of runsA) {
    const runB = runsB.get(key);
    if (!runB) continue;
    const pair = `[${shortId(runA.runId)} ↔ ${shortId(runB.runId)}]`;
    if (runA.status !== runB.status) {
      statusChanges.push(
        `- ${key}: ${runA.status} → ${runB.status} ${pair}${runB.error ? `  error: ${truncate(runB.error.message, 160)}` : ''}`,
      );
    }
    const latencyA = runA.latencyMs ?? 0;
    const latencyB = runB.latencyMs ?? 0;
    if (
      Math.abs(latencyA - latencyB) >= 100 &&
      Math.max(latencyA, latencyB) >= 2 * Math.max(1, Math.min(latencyA, latencyB))
    ) {
      latencyChanges.push(`- ${key}: ${formatMs(latencyA)} → ${formatMs(latencyB)} ${pair}`);
    }
    const tokensA = (runA.tokens?.input ?? 0) + (runA.tokens?.output ?? 0);
    const tokensB = (runB.tokens?.input ?? 0) + (runB.tokens?.output ?? 0);
    if (tokensA !== tokensB && Math.abs(tokensA - tokensB) >= 0.2 * Math.max(tokensA, tokensB)) {
      tokenChanges.push(`- ${key}: ${tokensA} → ${tokensB} tokens ${pair}`);
    }
  }

  const list = (title: string, items: string[]): string =>
    items.length === 0
      ? ''
      : `${title} (${items.length}):\n${items.slice(0, 30).join('\n')}${items.length > 30 ? `\n… ${items.length - 30} more` : ''}`;
  const sections = [
    `A: ${formatTraceRow(recordA.trace)}`,
    `B: ${formatTraceRow(recordB.trace)}`,
    list('status changes', statusChanges),
    list(
      'runs only in A',
      onlyA.map((key) => `- ${key} [${shortId((runsA.get(key) as RunTreeNode).runId)}]`),
    ),
    list(
      'runs only in B',
      onlyB.map((key) => `- ${key} [${shortId((runsB.get(key) as RunTreeNode).runId)}]`),
    ),
    list('latency changes (≥2×)', latencyChanges),
    list('token changes (≥20%)', tokenChanges),
  ].filter(Boolean);
  if (sections.length === 2)
    sections.push('Same run structure, statuses, latency and token profile.');
  sections.push(
    'Diff payloads of a matched pair with compare({ a: { traceId, runId }, b: { traceId, runId } }).',
  );
  return sections.join('\n\n');
}
