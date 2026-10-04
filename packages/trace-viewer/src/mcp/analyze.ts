import type { TraceRecord } from '@m4trix/tracing';
import { oneLine, safeStringify, truncate } from './json-utils';
import type { IndexedTrace } from './payload-index';
import {
  formatMs,
  formatRunLabel,
  type RunForest,
  type RunTreeNode,
  runAncestry,
  shortId,
  walkForest,
} from './trace-access';

export type AnalyzeOptions = {
  /** Same tool/LLM run with identical input at least this often is flagged as a possible loop. */
  repeatThreshold?: number;
  topN?: number;
};

const ERROR_KEY =
  /(^|[.[\]"'])(error|errors|err|exception|error_message|errorMessage|stderr)["'\]]*$/i;
const ERROR_TEXT = /^(error|exception)\b|Traceback \(most recent call last\)|^\w*Error: /i;
const FALSY_TEXT = new Set(['', 'false', '0', 'null', 'none', 'undefined']);
const CALL_TYPES = new Set(['tool', 'llm', 'chat_model', 'retriever']);

/**
 * Heuristic debugging report for one trace. Structure-only checks always run; checks that
 * need payload contents (hidden errors, exact repeated calls) run when the trace is loaded.
 */
export function analyzeTrace(
  record: TraceRecord,
  forest: RunForest,
  indexed: IndexedTrace | undefined,
  options: AnalyzeOptions = {},
): string {
  const topN = options.topN ?? 5;
  const repeatThreshold = options.repeatThreshold ?? 3;
  const runs: RunTreeNode[] = [];
  walkForest(forest, (node) => runs.push(node));
  const pathOf = (runId: string): string =>
    runAncestry(forest, runId)
      .map((node) => node.name)
      .join(' › ');

  const sections: string[] = [];
  const trace = record.trace;
  sections.push(
    `Trace ${trace.traceId} "${trace.name}" — ${trace.status}, ${runs.length} runs, ${formatMs(trace.latencyMs) || 'no latency'}${indexed ? ', payloads loaded' : ', payloads NOT loaded (call load_trace_payloads for payload checks)'}`,
  );

  // Errors: report the deepest failing runs as likely root causes.
  const errorRuns = runs.filter((run) => run.status === 'error');
  if (errorRuns.length > 0) {
    const hasErrorDescendant = (node: RunTreeNode): boolean =>
      node.children.some((child) => child.status === 'error' || hasErrorDescendant(child));
    const rootCauses = errorRuns.filter((run) => !hasErrorDescendant(run));
    const lines = rootCauses.slice(0, topN * 2).map((run) => {
      const error = run.error
        ? `${run.error.type ? `${run.error.type}: ` : ''}${run.error.message}`
        : 'no error message recorded';
      return `- ${formatRunLabel(run, { errorChars: 0 })}\n  path: ${pathOf(run.runId)}\n  error: ${truncate(oneLine(error), 500)}`;
    });
    sections.push(
      `## Errors (${errorRuns.length} error runs, ${rootCauses.length} root cause${rootCauses.length === 1 ? '' : 's'})\n${lines.join('\n')}`,
    );
  } else if (trace.status === 'error') {
    sections.push('## Errors\n- Trace is marked error but no run has error status.');
  }
  if (trace.status === 'success' && errorRuns.length > 0) {
    sections.push(
      '## Status mismatch\n- Trace succeeded although runs failed: errors were caught/retried upstream. Check that the fallback behaved as intended.',
    );
  }

  const unfinished = runs.filter((run) => run.status === 'running');
  if (unfinished.length > 0) {
    const state =
      trace.status === 'running'
        ? 'trace is still running'
        : 'trace finished, so these runs never ended (crash, lost callback, or missing flush)';
    sections.push(
      `## Unfinished runs (${unfinished.length}; ${state})\n${unfinished
        .slice(0, topN * 2)
        .map(
          (run) =>
            `- ${formatRunLabel(run)} started ${run.startTime}\n  path: ${pathOf(run.runId)}`,
        )
        .join('\n')}`,
    );
  }

  if (forest.orphanRunIds.length > 0) {
    sections.push(
      `## Orphan runs (${forest.orphanRunIds.length}; parent run missing from store)\n${forest.orphanRunIds
        .slice(0, topN * 2)
        .map((runId) => {
          const run = forest.byId.get(runId) as RunTreeNode;
          return `- ${formatRunLabel(run)} parent=${shortId(run.parentRunId ?? '')}`;
        })
        .join('\n')}`,
    );
  }

  sections.push(latencySection(forest, runs, topN));

  const tokenSection = tokenHotspots(runs, topN);
  if (tokenSection) sections.push(tokenSection);

  const repeats = repeatedCalls(runs, indexed, repeatThreshold, topN);
  if (repeats) sections.push(repeats);

  if (indexed) {
    const hidden = hiddenErrors(runs, indexed, topN * 2, pathOf);
    if (hidden) sections.push(hidden);
  }

  return sections.join('\n\n');
}

function latencySection(forest: RunForest, runs: RunTreeNode[], topN: number): string {
  const lines: string[] = [];
  const root = forest.roots[0];
  if (root?.latencyMs !== undefined) {
    const chain: string[] = [];
    let current: RunTreeNode | undefined = root;
    while (current) {
      chain.push(`${current.name} (${formatMs(current.latencyMs) || '?'})`);
      current = [...current.children]
        .filter((child) => child.latencyMs !== undefined)
        .sort((left, right) => (right.latencyMs ?? 0) - (left.latencyMs ?? 0))[0];
    }
    lines.push(`critical path: ${chain.join(' › ')}`);
  }

  const selfTimes = runs
    .filter((run) => run.latencyMs !== undefined)
    .map((run) => {
      const childTime = run.children.reduce((sum, child) => sum + (child.latencyMs ?? 0), 0);
      return { run, self: Math.max(0, (run.latencyMs ?? 0) - childTime) };
    })
    .filter((item) => item.self > 0)
    .sort((left, right) => right.self - left.self)
    .slice(0, topN);
  if (selfTimes.length > 0) {
    lines.push('largest self time (latency not explained by child runs):');
    for (const { run, self } of selfTimes)
      lines.push(`- ${formatMs(self)} self  ${formatRunLabel(run)}`);
  }
  return `## Latency\n${lines.join('\n') || 'no latency data'}`;
}

function tokenHotspots(runs: RunTreeNode[], topN: number): string | null {
  const withTokens = runs.filter((run) => run.tokens);
  if (withTokens.length === 0) return null;
  const hasTokenDescendant = (node: RunTreeNode): boolean =>
    node.children.some((child) => child.tokens !== undefined || hasTokenDescendant(child));
  // Leaf-most token carriers avoid double counting parents that roll usage up.
  const leaves = withTokens.filter((run) => !hasTokenDescendant(run));
  const total = leaves.reduce(
    (sum, run) => ({
      input: sum.input + (run.tokens?.input ?? 0),
      output: sum.output + (run.tokens?.output ?? 0),
    }),
    { input: 0, output: 0 },
  );
  const top = [...leaves]
    .sort((left, right) => totalTokens(right) - totalTokens(left))
    .slice(0, topN)
    .map((run) => `- ${formatRunLabel(run)}`);
  return `## Tokens (${leaves.length} runs, input ${total.input}, output ${total.output})\n${top.join('\n')}`;
}

function totalTokens(run: RunTreeNode): number {
  return (run.tokens?.input ?? 0) + (run.tokens?.output ?? 0);
}

function repeatedCalls(
  runs: RunTreeNode[],
  indexed: IndexedTrace | undefined,
  threshold: number,
  topN: number,
): string | null {
  const groups = new Map<string, RunTreeNode[]>();
  for (const run of runs) {
    if (!CALL_TYPES.has(run.type)) continue;
    const input = indexed && run.inputRef ? indexed.payloads.get(run.inputRef)?.value : undefined;
    const key = indexed
      ? `${run.type}\u0000${run.name}\u0000${safeStringify(input)}`
      : `${run.type}\u0000${run.name}`;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }

  // Without payloads only call counts are known, so require more evidence.
  const minCount = indexed ? threshold : threshold * 2;
  const flagged = [...groups.values()]
    .filter((group) => group.length >= minCount)
    .sort((left, right) => right.length - left.length)
    .slice(0, topN);
  if (flagged.length === 0) return null;

  const label = indexed ? 'identical input' : 'same name (load payloads to compare inputs)';
  const lines = flagged.map((group) => {
    const first = group[0];
    const ids = group
      .slice(0, 6)
      .map((run) => shortId(run.runId))
      .join(', ');
    return `- ${group.length}× ${first.type} ${first.name} — ${ids}${group.length > 6 ? ', …' : ''}`;
  });
  return `## Repeated calls (${label}; possible loop or missing cache)\n${lines.join('\n')}`;
}

function hiddenErrors(
  runs: RunTreeNode[],
  indexed: IndexedTrace,
  limit: number,
  pathOf: (runId: string) => string,
): string | null {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const run of runs) {
    if (run.status === 'error' || !run.outputRef) continue;
    const payload = indexed.payloads.get(run.outputRef);
    if (!payload) continue;
    for (const leaf of payload.leaves) {
      const text = leaf.text.trim();
      const errorish =
        (ERROR_KEY.test(leaf.path) && !FALSY_TEXT.has(text.toLowerCase())) ||
        ERROR_TEXT.test(text) ||
        (/\.(is_error|isError)$/.test(leaf.path) && text === 'true') ||
        (/\.status$/.test(leaf.path) && text.toLowerCase() === 'error');
      if (!errorish || seen.has(text)) continue;
      seen.add(text);
      lines.push(
        `- ${formatRunLabel(run)} output ${leaf.path}\n  path: ${pathOf(run.runId)}\n  value: ${truncate(oneLine(text), 300)}`,
      );
      if (lines.length >= limit) break;
    }
    if (lines.length >= limit) break;
  }
  if (lines.length === 0) return null;
  return `## Error-like values in successful runs (handled or swallowed errors)\n${lines.join('\n')}`;
}
