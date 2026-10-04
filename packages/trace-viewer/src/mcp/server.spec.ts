import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTraceMcpServer } from './server';
import { createFixtureTraceApi, FAILING_TRACE_ID } from './test-fixtures';

let client: Client;

beforeEach(async () => {
  const { api } = await createFixtureTraceApi();
  const server = createTraceMcpServer({ traceViewerApi: api, version: '1.2.3' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function textOf(result: CallToolResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

describe('createTraceMcpServer', () => {
  it('advertises the trace tools with instructions and annotations', async () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'm4trix-traces', version: '1.2.3' });
    expect(client.getInstructions()).toContain('load_trace_payloads');

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'analyze_trace',
      'annotate',
      'compare',
      'find_runs',
      'get_conversation',
      'get_payload',
      'get_run',
      'get_trace',
      'list_traces',
      'load_trace_payloads',
      'search_payloads',
    ]);

    const annotate = tools.find((tool) => tool.name === 'annotate');
    expect(annotate?.description).toContain('ask the user for permission');
    expect(annotate?.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((tool) => tool.name === 'get_trace')?.annotations?.readOnlyHint).toBe(true);
  });

  it('runs a load → search flow end to end', async () => {
    const loaded = await call('load_trace_payloads', { traceIds: ['latest', FAILING_TRACE_ID] });
    expect(loaded.isError).toBeFalsy();
    expect(textOf(loaded)).toContain('index: 2 traces');

    const search = await call('search_payloads', { query: 'shipped' });
    expect(textOf(search)).toContain('tool lookup_order [b-tool] · output $.status');
  });

  it('returns tool errors as isError results', async () => {
    const missing = await call('get_trace', { traceId: 'does-not-exist' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe('Trace "does-not-exist" not found.');

    const invalid = await call('get_payload', {
      traceId: FAILING_TRACE_ID,
      runId: 'a-llm',
      path: 'messages',
    });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toContain('Path must start with "$"');
  });

  it('rejects arguments that fail schema validation', async () => {
    const result = await call('list_traces', { limit: 0 });
    expect(result.isError).toBe(true);
  });
});
