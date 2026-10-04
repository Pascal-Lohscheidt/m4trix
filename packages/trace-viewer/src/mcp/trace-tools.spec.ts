import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TraceViewerApi } from '@m4trix/tracing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtureTraceApi, FAILING_TRACE_ID, PASSING_TRACE_ID } from './test-fixtures';
import { TraceToolError } from './trace-access';
import { TraceTools } from './trace-tools';

let api: TraceViewerApi;
let dir: string;
let tools: TraceTools;

beforeEach(async () => {
  ({ api, dir } = await createFixtureTraceApi());
  tools = new TraceTools(api);
});

describe('listTraces', () => {
  it('lists newest first and filters by status and metadata', async () => {
    const all = await tools.listTraces({});
    expect(all.indexOf(PASSING_TRACE_ID)).toBeLessThan(all.indexOf(FAILING_TRACE_ID));

    const failing = await tools.listTraces({ status: 'error', metadata: { env: 'dev' } });
    expect(failing).toContain(FAILING_TRACE_ID);
    expect(failing).not.toContain(PASSING_TRACE_ID);
  });

  it('paginates with offset', async () => {
    const first = await tools.listTraces({ limit: 1 });
    expect(first).toContain(PASSING_TRACE_ID);
    expect(first).toContain('offset=1');
    const second = await tools.listTraces({ limit: 1, offset: 1 });
    expect(second).toContain(FAILING_TRACE_ID);
    expect(await tools.listTraces({ name: 'nope' })).toBe('No traces match.');
  });

  it('rejects invalid name regexes', async () => {
    await expect(tools.listTraces({ name: '(' })).rejects.toThrow(TraceToolError);
  });
});

describe('getTrace', () => {
  it('resolves latest and id prefixes and hides LangGraph noise by default', async () => {
    const latest = await tools.getTrace({ traceId: 'latest' });
    expect(latest).toContain(PASSING_TRACE_ID);

    const tree = await tools.getTrace({ traceId: 'aaaa1111' });
    expect(tree).toContain('✗ tool lookup_order');
    expect(tree).toContain('Order service timeout');
    expect(tree.split('\n\n')[1]).not.toContain('ChannelWrite');
    expect(tree).toContain('1 run hidden');

    expect(await tools.getTrace({ traceId: 'aaaa1111', hide: '' })).toContain('ChannelWrite<...>');
  });

  it('focuses a subtree and limits depth', async () => {
    const focused = await tools.getTrace({ traceId: FAILING_TRACE_ID, focusRunId: 'a-tool' });
    expect(focused).toContain('focus: support-agent › lookup_order');
    expect(focused).not.toContain('cache_get');

    const shallow = await tools.getTrace({ traceId: FAILING_TRACE_ID, maxDepth: 0 });
    expect(shallow).toContain('runs below max depth');
  });

  it('fails for unknown traces and ambiguous run prefixes', async () => {
    await expect(tools.getTrace({ traceId: 'zzzz' })).rejects.toThrow('Trace "zzzz" not found.');
    await expect(
      tools.getTrace({ traceId: FAILING_TRACE_ID, focusRunId: 'a-cache' }),
    ).rejects.toThrow('ambiguous');
  });
});

describe('findRuns', () => {
  it('finds error runs across traces', async () => {
    const result = await tools.findRuns({ status: 'error', type: ['tool'] });
    expect(result).toContain('1 matching run in 2 searched traces');
    expect(result).toContain('lookup_order');
  });

  it('filters by error text, name and latency', async () => {
    expect(await tools.findRuns({ errorContains: 'TIMEOUT' })).toContain('[a-tool]');
    expect(await tools.findRuns({ name: '^cache', limit: 1 })).toContain('2 more matches');
    expect(await tools.findRuns({ minLatencyMs: 100_000 })).toBe('No runs match in 2 traces.');
  });
});

describe('getRun', () => {
  it('shows ancestry, full error and decoded payload previews', async () => {
    const result = await tools.getRun({ traceId: FAILING_TRACE_ID, runId: 'a-tool' });
    expect(result).toContain('path: support-agent › lookup_order');
    expect(result).toContain('error: TimeoutError: Order service timeout after 3000ms');
    expect(result).toContain('input: {"orderId":42}');
    expect(result).toContain('output: (none)');
  });
});

describe('getPayload', () => {
  it('reads a path inside a payload', async () => {
    const result = await tools.getPayload({
      traceId: FAILING_TRACE_ID,
      runId: 'a-llm',
      side: 'input',
      path: '$.messages[-1].content',
    });
    expect(result).toBe(
      'input of chat_model ChatOpenAI [a-llm] at $.messages[1].content\nWhere is my order 42?',
    );
  });

  it('falls back to an outline when too large and pages in json mode', async () => {
    const outline = await tools.getPayload({
      traceId: FAILING_TRACE_ID,
      runId: 'a-llm',
      side: 'input',
      maxChars: 20,
    });
    expect(outline).toContain('too large for one response');
    expect(outline).toContain('$.messages  array[2]');

    const page = await tools.getPayload({
      traceId: FAILING_TRACE_ID,
      runId: 'a-llm',
      side: 'input',
      mode: 'json',
      maxChars: 20,
    });
    expect(page).toContain('continue with offset=20');
  });

  it('lists multiple matches and explains missing ones', async () => {
    const many = await tools.getPayload({
      traceId: FAILING_TRACE_ID,
      runId: 'a-llm',
      side: 'input',
      path: '$.messages[*].role',
    });
    expect(many).toContain('2 matches');
    expect(many).toContain('$.messages[0].role: "system"');

    const none = await tools.getPayload({
      traceId: FAILING_TRACE_ID,
      runId: 'a-llm',
      side: 'input',
      path: '$.nope',
    });
    expect(none).toContain('matched nothing');
  });

  it('fails when the run has no payload on that side', async () => {
    await expect(
      tools.getPayload({ traceId: FAILING_TRACE_ID, runId: 'a-notify' }),
    ).rejects.toThrow('has no output payload yet (still running)');
    await expect(tools.getPayload({ traceId: FAILING_TRACE_ID })).rejects.toThrow(
      'Pass either ref',
    );
  });
});

describe('loadTracePayloads + searchPayloads', () => {
  it('requires loading before searching everything', async () => {
    expect(await tools.searchPayloads({ query: 'order' })).toContain('No payloads loaded yet');
  });

  it('loads traces and groups identical values at their first occurrence', async () => {
    const loaded = await tools.loadTracePayloads({ traceIds: [FAILING_TRACE_ID] });
    expect(loaded).toContain('11 loaded');

    const result = await tools.searchPayloads({ query: 'cache miss' });
    expect(result).toContain('1 distinct matching value (3 occurrences)');
    expect(result).toContain('first: trace aaaa1111 · tool cache_get [a-cache-1] · output $.error');
    expect(result).toContain('in support-agent');

    const reloaded = await tools.loadTracePayloads({ traceIds: [FAILING_TRACE_ID] });
    expect(reloaded).toContain('0 loaded, 11 cached');
  });

  it('auto-loads traceIds and searches inside decoded JSON strings', async () => {
    const result = await tools.searchPayloads({
      query: '^42$',
      regex: true,
      traceIds: [PASSING_TRACE_ID],
      side: 'input',
    });
    expect(result).toContain('tool lookup_order [b-tool] · input $.orderId');
    expect(result).not.toContain('aaaa1111');
  });

  it('applies run filters and rejects invalid regexes', async () => {
    await tools.loadTracePayloads({});
    const result = await tools.searchPayloads({ query: 'order 42', runType: ['chain'] });
    expect(result).toContain('chain support-agent');
    expect(result).not.toContain('ChatOpenAI');
    await expect(tools.searchPayloads({ query: '(', regex: true })).rejects.toThrow(
      'Invalid query regex',
    );
  });

  it('reports payloads that failed to load', async () => {
    const getPayload = vi.spyOn(api, 'getPayload').mockRejectedValueOnce(new Error('denied'));
    const loaded = await tools.loadTracePayloads({ traceIds: [PASSING_TRACE_ID] });
    expect(getPayload).toHaveBeenCalled();
    expect(loaded).toContain('1 failed (denied)');
    expect(await tools.searchPayloads({ query: 'zzz' })).toContain('1 payload failed to load');
  });
});

describe('analyzeTrace', () => {
  it('reports root causes, unfinished runs, loops and swallowed errors', async () => {
    const report = await tools.analyzeTrace({ traceId: FAILING_TRACE_ID });
    expect(report).toContain('## Errors (2 error runs, 1 root cause)');
    expect(report).toContain('path: support-agent › lookup_order');
    expect(report).toContain('## Unfinished runs (1; trace finished');
    expect(report).toContain('3× tool cache_get');
    expect(report).toContain('cache miss for order:42');
    expect(report).toContain('critical path: support-agent (5.00s) › lookup_order (3.00s)');
  });

  it('skips payload checks when payloads are not loaded', async () => {
    const report = await tools.analyzeTrace({ traceId: FAILING_TRACE_ID, loadPayloads: false });
    expect(report).toContain('payloads NOT loaded');
    expect(report).not.toContain('Error-like values');
  });
});

describe('getConversation', () => {
  it('renders chat input and tool calls from the output', async () => {
    const result = await tools.getConversation({ traceId: FAILING_TRACE_ID, runId: 'a-llm' });
    expect(result).toContain('[input $.messages] 2 messages');
    expect(result).toContain('#1 user: Where is my order 42?');
    expect(result).toContain('↳ tool_call lookup_order id=call_1 {"orderId":42}');
  });

  it('keeps the last messages when capped and explains when none exist', async () => {
    const capped = await tools.getConversation({
      traceId: FAILING_TRACE_ID,
      runId: 'a-llm',
      side: 'input',
      maxMessages: 1,
    });
    expect(capped).toContain('(first 1 omitted)');
    expect(capped).toContain('#1 user');
    expect(capped).not.toContain('#0 system');

    expect(await tools.getConversation({ traceId: FAILING_TRACE_ID, runId: 'a-tool' })).toContain(
      'No chat messages recognized',
    );
  });
});

describe('compare', () => {
  it('diffs two runs field by field and payload by payload', async () => {
    const result = await tools.compare({
      a: { traceId: FAILING_TRACE_ID, runId: 'a-tool' },
      b: { traceId: PASSING_TRACE_ID, runId: 'b-tool' },
    });
    expect(result).toContain('~ status: "error" → "success"');
    expect(result).toContain('input: identical');
    expect(result).toContain('~ $: undefined → {"orderId":42,"status":"shipped"}');
  });

  it('aligns trace structure', async () => {
    const result = await tools.compare({
      a: { traceId: FAILING_TRACE_ID },
      b: { traceId: PASSING_TRACE_ID },
    });
    expect(result).toContain('- tool lookup_order #1: error → success [a-tool ↔ b-tool]');
    expect(result).toContain('runs only in A (5)');
    expect(result).toContain('latency changes');
  });

  it('requires runId on both sides or neither', async () => {
    await expect(
      tools.compare({
        a: { traceId: FAILING_TRACE_ID, runId: 'a-tool' },
        b: { traceId: PASSING_TRACE_ID },
      }),
    ).rejects.toThrow('Pass runId for both sides');
  });
});

describe('annotate', () => {
  it('merges annotations onto traces and runs in the store', async () => {
    await tools.annotate({
      traceId: FAILING_TRACE_ID,
      annotation: { agent_notes: 'timeout upstream' },
    });
    const trace = JSON.parse(
      await readFile(join(dir, 'traces', FAILING_TRACE_ID, 'trace.json'), 'utf-8'),
    );
    expect(trace.annotation).toEqual({ agent_notes: 'timeout upstream' });

    const result = await tools.annotate({
      traceId: FAILING_TRACE_ID,
      runId: 'a-tool',
      annotation: { cause: 'timeout' },
    });
    expect(result).toBe('Annotated run a-tool (lookup_order): {"cause":"timeout"}');
  });

  it('fails for unknown runs', async () => {
    await expect(
      tools.annotate({ traceId: FAILING_TRACE_ID, runId: 'missing', annotation: {} }),
    ).rejects.toThrow('Run "missing" not found');
  });
});
