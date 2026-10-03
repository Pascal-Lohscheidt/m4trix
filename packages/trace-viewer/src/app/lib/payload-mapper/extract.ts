import { evaluateFirst, evaluatePath } from './json-path';
import type { MappingView, MessagesView } from './mapping-schema';

export const MAX_RENDERED_ITEMS = 200;

export type ResolvedToolCall = { name: string | null; args: unknown; id: string | null };

export type ResolvedContentPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'toolCall'; call: ResolvedToolCall }
  | {
      type: 'toolResult';
      toolCallId: string | null;
      isError: boolean;
      parts: ResolvedContentPart[];
    }
  | { type: 'image'; label: string }
  | { type: 'json'; value: unknown };

export type RoleClass = 'user' | 'assistant' | 'system' | 'tool' | 'other';

export type ResolvedMessage = {
  role: string;
  roleClass: RoleClass;
  name: string | null;
  parts: ResolvedContentPart[];
  toolCalls: ResolvedToolCall[];
  toolCallId: string | null;
  collapsed: boolean;
};

export type ResolvedView =
  | { kind: 'messages'; title?: string; messages: ResolvedMessage[]; totalCount: number }
  | { kind: 'toolCall'; title?: string; call: ResolvedToolCall }
  | {
      kind: 'toolResult';
      title?: string;
      name: string | null;
      status: string | null;
      parts: ResolvedContentPart[] | null;
      body: ResolvedView | null;
    }
  | { kind: 'keyValue'; title?: string; entries: { label: string; value: unknown }[] }
  | { kind: 'markdown'; title?: string; value: string }
  | { kind: 'text'; title?: string; value: string }
  | { kind: 'code'; title?: string; value: string; language: string | null }
  | { kind: 'table'; title?: string; columns: string[]; rows: unknown[][]; totalCount: number }
  | { kind: 'json'; title?: string; value: unknown }
  | { kind: 'stack'; title?: string; children: ResolvedView[] }
  | { kind: 'fallback'; title?: string; value: unknown; reason: string };

export type ResolveResult = {
  view: ResolvedView;
  /** Paths that were configured but resolved to nothing (partial matches). */
  issues: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Parse JSON-encoded tool arguments (OpenAI style) when possible. */
export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function classifyRole(role: string): RoleClass {
  const r = role.toLowerCase();
  if (r.includes('human') || r.includes('user')) return 'user';
  if (r === 'ai' || r.startsWith('aimessage') || r.includes('assistant') || r === 'model') {
    return 'assistant';
  }
  if (r.includes('system') || r === 'developer') return 'system';
  if (r.includes('tool') || r.includes('function')) return 'tool';
  return 'other';
}

/** Heuristic tool call from common provider / LangChain shapes. */
export function normalizeToolCall(value: unknown): ResolvedToolCall {
  const o = asRecord(value);
  if (!o) return { name: null, args: value, id: null };
  const fn = asRecord(o.function);
  return {
    name: asString(o.name) ?? asString(fn?.name),
    args: parseMaybeJson(o.args ?? o.input ?? o.arguments ?? fn?.arguments),
    id: asString(o.id) ?? asString(o.call_id) ?? asString(o.tool_call_id),
  };
}

/** Normalize string / content-block arrays (Anthropic, OpenAI, LangChain) into parts. */
export function normalizeContent(value: unknown): ResolvedContentPart[] {
  if (value == null) return [];
  if (typeof value === 'string') return value === '' ? [] : [{ type: 'text', text: value }];
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [{ type: 'text', text: String(value) }];
  }
  if (Array.isArray(value)) return value.flatMap((item) => normalizeContentBlock(item));
  return normalizeContentBlock(value);
}

function normalizeContentBlock(block: unknown): ResolvedContentPart[] {
  if (typeof block === 'string') return block === '' ? [] : [{ type: 'text', text: block }];
  const o = asRecord(block);
  if (!o) return block == null ? [] : [{ type: 'json', value: block }];
  const type = typeof o.type === 'string' ? o.type : null;

  switch (type) {
    case 'text':
    case 'input_text':
    case 'output_text':
      if (typeof o.text === 'string') return [{ type: 'text', text: o.text }];
      break;
    case 'thinking':
    case 'reasoning':
      if (typeof o.thinking === 'string') return [{ type: 'reasoning', text: o.thinking }];
      if (typeof o.text === 'string') return [{ type: 'reasoning', text: o.text }];
      break;
    case 'tool_use':
    case 'function_call':
    case 'tool_call':
      return [{ type: 'toolCall', call: normalizeToolCall(o) }];
    case 'tool_result':
    case 'function_call_output':
      return [
        {
          type: 'toolResult',
          toolCallId: asString(o.tool_use_id) ?? asString(o.call_id),
          isError: o.is_error === true,
          parts: normalizeContent(o.content ?? o.output),
        },
      ];
    case 'image':
    case 'image_url':
    case 'input_image':
      return [{ type: 'image', label: type }];
    default:
      break;
  }
  if (type === null && typeof o.text === 'string' && Object.keys(o).length <= 2) {
    return [{ type: 'text', text: o.text }];
  }
  return [{ type: 'json', value: block }];
}

class Resolver {
  readonly issues: string[] = [];

  private note(kind: string, field: string, path: string): void {
    this.issues.push(`${kind}.${field}: no match for ${path}`);
  }

  private first(scope: unknown, path: string | undefined, kind: string, field: string): unknown {
    if (!path) return undefined;
    const value = evaluateFirst(scope, path);
    if (value === undefined) this.note(kind, field, path);
    return value;
  }

  resolve(view: MappingView, scope: unknown): ResolvedView {
    const title = view.title;
    let base = scope;
    if (view.at) {
      base = evaluateFirst(scope, view.at);
      if (base === undefined) {
        this.note(view.kind, 'at', view.at);
        return { kind: 'fallback', title, value: scope, reason: `No match for ${view.at}` };
      }
    }

    switch (view.kind) {
      case 'messages':
        return this.resolveMessages(view, base);
      case 'toolCall': {
        const heuristic = normalizeToolCall(base);
        const name = view.name ? asString(this.first(base, view.name, 'toolCall', 'name')) : null;
        const args = view.args ? this.first(base, view.args, 'toolCall', 'args') : undefined;
        const id = view.id ? asString(this.first(base, view.id, 'toolCall', 'id')) : null;
        return {
          kind: 'toolCall',
          title,
          call: {
            name: name ?? heuristic.name,
            args: args !== undefined ? parseMaybeJson(args) : heuristic.args,
            id: id ?? heuristic.id,
          },
        };
      }
      case 'toolResult': {
        const content = view.content
          ? this.first(base, view.content, 'toolResult', 'content')
          : undefined;
        return {
          kind: 'toolResult',
          title,
          name: asString(this.first(base, view.name, 'toolResult', 'name')),
          status: asString(this.first(base, view.status, 'toolResult', 'status')),
          parts: content !== undefined ? normalizeContent(parseMaybeJson(content)) : null,
          body: view.body ? this.resolve(view.body, base) : null,
        };
      }
      case 'keyValue': {
        const entries = view.entries
          .map((entry) => ({
            label: entry.label,
            value: this.first(base, entry.value, 'keyValue', entry.label),
          }))
          .filter((entry) => entry.value !== undefined);
        if (entries.length === 0) {
          return { kind: 'fallback', title, value: base, reason: 'No key/value entries matched' };
        }
        return { kind: 'keyValue', title, entries };
      }
      case 'markdown':
      case 'text': {
        const value = this.first(base, view.value, view.kind, 'value');
        if (value === undefined || value === null) {
          return { kind: 'fallback', title, value: base, reason: `No match for ${view.value}` };
        }
        return { kind: view.kind, title, value: stringify(value) };
      }
      case 'code': {
        const value = this.first(base, view.value, 'code', 'value');
        if (value === undefined || value === null) {
          return { kind: 'fallback', title, value: base, reason: `No match for ${view.value}` };
        }
        const isObject = typeof value === 'object';
        return {
          kind: 'code',
          title,
          value: stringify(value),
          language: view.language ?? (isObject ? 'json' : null),
        };
      }
      case 'table': {
        const rows = evaluatePath(base, view.rows);
        if (rows.length === 0) {
          this.note('table', 'rows', view.rows);
          return { kind: 'fallback', title, value: base, reason: `No rows for ${view.rows}` };
        }
        return {
          kind: 'table',
          title,
          columns: view.columns.map((c) => c.label),
          rows: rows
            .slice(0, MAX_RENDERED_ITEMS)
            .map((row) => view.columns.map((c) => evaluateFirst(row, c.value))),
          totalCount: rows.length,
        };
      }
      case 'json': {
        const value = view.value ? this.first(base, view.value, 'json', 'value') : base;
        return { kind: 'json', title, value: value === undefined ? base : value };
      }
      case 'stack':
        return {
          kind: 'stack',
          title,
          children: view.children.map((child) => this.resolve(child, base)),
        };
    }
  }

  private resolveMessages(view: MessagesView, base: unknown): ResolvedView {
    const items = evaluatePath(base, view.items);
    if (items.length === 0) {
      this.note('messages', 'items', view.items);
      return {
        kind: 'fallback',
        title: view.title,
        value: base,
        reason: `No messages for ${view.items}`,
      };
    }
    const collapse = new Set((view.collapseRoles ?? []).map((r) => r.toLowerCase()));
    let missingRole = false;
    let missingContent = false;

    const messages = items.slice(0, MAX_RENDERED_ITEMS).map((item): ResolvedMessage => {
      const o = asRecord(item);
      // Configured paths win; on a miss fall back to common shapes so mixed arrays
      // (e.g. plain `{ role, content }` next to LangChain constructors) still render.
      let roleValue = view.role ? evaluateFirst(item, view.role) : undefined;
      if (view.role && roleValue === undefined) missingRole = true;
      roleValue ??= o?.role ?? o?.type;
      const role = asString(roleValue) ?? 'message';

      let contentValue = view.content ? evaluateFirst(item, view.content) : undefined;
      if (view.content && contentValue === undefined) missingContent = true;
      contentValue ??= o && 'content' in o ? o.content : item;

      const toolCalls = view.toolCalls
        ? evaluatePath(item, view.toolCalls.items).map((call) => {
            const tc = view.toolCalls;
            const heuristic = normalizeToolCall(call);
            const name = tc?.name ? asString(evaluateFirst(call, tc.name)) : null;
            const args = tc?.args ? evaluateFirst(call, tc.args) : undefined;
            const id = tc?.id ? asString(evaluateFirst(call, tc.id)) : null;
            return {
              name: name ?? heuristic.name,
              args: args !== undefined ? parseMaybeJson(args) : heuristic.args,
              id: id ?? heuristic.id,
            };
          })
        : [];

      const roleClass = classifyRole(role);
      return {
        role,
        roleClass,
        name: view.name ? asString(evaluateFirst(item, view.name)) : null,
        parts: normalizeContent(contentValue),
        toolCalls,
        toolCallId: view.toolCallId ? asString(evaluateFirst(item, view.toolCallId)) : null,
        collapsed: collapse.has(role.toLowerCase()) || collapse.has(roleClass),
      };
    });

    if (missingRole && view.role) this.note('messages', 'role', view.role);
    if (missingContent && view.content) this.note('messages', 'content', view.content);
    return { kind: 'messages', title: view.title, messages, totalCount: items.length };
  }
}

export function resolveView(view: MappingView, scope: unknown): ResolveResult {
  const resolver = new Resolver();
  const resolved = resolver.resolve(view, scope);
  return { view: resolved, issues: resolver.issues };
}
