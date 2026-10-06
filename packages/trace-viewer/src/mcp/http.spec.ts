import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTraceViewerServer } from '../server/start-server';
import { isAllowedMcpRequest } from './http';
import { createFixtureTraceApi, PASSING_TRACE_ID } from './test-fixtures';

let server: http.Server;
let port: number;
const clients: Client[] = [];

async function startServer(mcp?: boolean): Promise<void> {
  const { api } = await createFixtureTraceApi();
  server = startTraceViewerServer({ traceViewerApi: api, port: 0, mcp, version: '9.9.9' });
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
}

async function connect(): Promise<Client> {
  const client = new Client({ name: 'http-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  clients.push(client);
  return client;
}

function rawRequest(
  method: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

function textOf(result: CallToolResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await new Promise((resolve) => server.close(resolve));
});

describe('MCP over HTTP on the viewer server', () => {
  beforeEach(async () => {
    await startServer();
  });

  it('serves the trace tools at /mcp', async () => {
    const client = await connect();
    expect(client.getServerVersion()).toMatchObject({ name: 'm4trix-traces', version: '9.9.9' });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('search_payloads');
  });

  it('keeps loaded payloads across separate client connections', async () => {
    const first = await connect();
    await first.callTool({
      name: 'load_trace_payloads',
      arguments: { traceIds: [PASSING_TRACE_ID] },
    });

    const second = await connect();
    const result = (await second.callTool({
      name: 'search_payloads',
      arguments: { query: 'shipped' },
    })) as CallToolResult;
    expect(textOf(result)).toContain('tool lookup_order [b-tool] · output $.status');
  });

  it('rejects non-POST methods and non-local hosts or origins', async () => {
    expect((await rawRequest('GET', {})).status).toBe(405);
    expect((await rawRequest('POST', { Host: 'evil.example:80' })).status).toBe(403);
    expect((await rawRequest('POST', { Origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('startTraceViewerServer with mcp disabled', () => {
  it('does not route /mcp to the MCP handler', async () => {
    await startServer(false);
    const response = await rawRequest('GET', {});
    expect(response.status).not.toBe(405);
    expect(response.body).not.toContain('jsonrpc');
  });
});

describe('isAllowedMcpRequest', () => {
  const request = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

  it('accepts loopback hosts with or without a loopback origin', () => {
    expect(isAllowedMcpRequest(request({ host: '127.0.0.1:4319' }))).toBe(true);
    expect(
      isAllowedMcpRequest(request({ host: 'localhost:4319', origin: 'http://localhost:3000' })),
    ).toBe(true);
    expect(isAllowedMcpRequest(request({ host: '[::1]:4319' }))).toBe(true);
  });

  it('rejects foreign hosts, foreign origins and missing hosts unless allowed', () => {
    expect(isAllowedMcpRequest(request({ host: 'attacker.test' }))).toBe(false);
    expect(
      isAllowedMcpRequest(request({ host: '127.0.0.1', origin: 'https://attacker.test' })),
    ).toBe(false);
    expect(isAllowedMcpRequest(request({}))).toBe(false);
    expect(isAllowedMcpRequest(request({ host: 'devbox:4319' }), ['devbox'])).toBe(true);
  });
});
