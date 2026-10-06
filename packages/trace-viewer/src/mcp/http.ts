import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TraceViewerApi } from '@m4trix/tracing';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { PayloadIndexOptions } from './payload-index';
import { createTraceMcpServer } from './server';
import { TraceTools } from './trace-tools';

export const MCP_HTTP_PATH = '/mcp';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export type TraceMcpHttpHandlerOptions = {
  traceViewerApi: TraceViewerApi;
  index?: PayloadIndexOptions;
  version?: string;
  /** Extra hostnames accepted in the Host header, e.g. when bound to a non-loopback interface. */
  allowedHostnames?: string[];
};

export type TraceMcpHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function hostnameOf(value: string): string | null {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Guards against DNS rebinding and cross-site requests from browser pages: the Host must be
 * loopback (or explicitly allowed) and an Origin, when sent, must be loopback too.
 */
export function isAllowedMcpRequest(
  req: IncomingMessage,
  allowedHostnames: string[] = [],
): boolean {
  const allowed = new Set([...LOOPBACK_HOSTNAMES, ...allowedHostnames]);
  const host = req.headers.host ? hostnameOf(req.headers.host) : null;
  if (!host || !allowed.has(host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const originHost = hostnameOf(origin);
  return originHost !== null && LOOPBACK_HOSTNAMES.has(originHost);
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * Streamable HTTP MCP endpoint in stateless mode: each POST gets a fresh protocol server, while
 * the tool state (payload index) is shared, so payloads loaded by one call stay searchable.
 */
export function createTraceMcpHttpHandler(
  options: TraceMcpHttpHandlerOptions,
): TraceMcpHttpHandler {
  const tools = new TraceTools(options.traceViewerApi, { index: options.index });

  return async (req, res) => {
    if (!isAllowedMcpRequest(req, options.allowedHostnames)) {
      sendJsonRpcError(res, 403, 'Forbidden: MCP endpoint only accepts local requests.');
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJsonRpcError(
        res,
        405,
        'Method not allowed: this stateless MCP endpoint only accepts POST.',
      );
      return;
    }

    const server = createTraceMcpServer({
      traceViewerApi: options.traceViewerApi,
      version: options.version,
      tools,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, error instanceof Error ? error.message : String(error));
      }
    }
  };
}
