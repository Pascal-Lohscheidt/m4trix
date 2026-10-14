import { JSONSchema, type Schema as S, SchemaAST } from 'effect';
import { ToolDefinitionError } from './tool-errors.js';

/**
 * A tool's parameters as a plain JSON Schema object, ready for an LLM provider.
 *
 * Mutable on purpose so the formatter results are assignable to provider SDK parameter types
 * (which use mutable arrays).
 */
export type ToolParametersJsonSchema = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: Array<string>;
  [key: string]: unknown;
};

/** Provider-neutral description of a tool: what every formatter below is built from. */
export type ToolJsonSchema = {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParametersJsonSchema;
};

type JsonRecord = Record<string, unknown>;

const DEFS_PREFIX = '#/$defs/';
/** Keywords whose value maps names to schemas (the map itself is not a schema). */
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
/** Keywords whose value is data, never a schema. */
const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples']);
/** Annotations that only add noise (or change `$ref` resolution) for providers. */
const DROPPED_KEYWORDS = new Set(['$schema', '$id', '$comment']);

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const defNameOf = (node: JsonRecord): string | undefined => {
  const ref = node.$ref;
  return typeof ref === 'string' && ref.startsWith(DEFS_PREFIX)
    ? ref.slice(DEFS_PREFIX.length).replace(/~1/g, '/').replace(/~0/g, '~')
    : undefined;
};

function collectRefs(node: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, into);
  } else if (isRecord(node)) {
    const name = defNameOf(node);
    if (name !== undefined) into.add(name);
    for (const [key, value] of Object.entries(node)) {
      if (!DATA_KEYWORDS.has(key)) collectRefs(value, into);
    }
  }
  return into;
}

/** Definitions that can reach themselves through `$ref`s; those cannot be inlined. */
function recursiveDefinitions(defs: JsonRecord): Set<string> {
  const edges = new Map<string, Set<string>>();
  for (const [name, def] of Object.entries(defs)) edges.set(name, collectRefs(def, new Set()));
  const recursive = new Set<string>();
  for (const start of edges.keys()) {
    const seen = new Set<string>();
    const pending = [...(edges.get(start) ?? [])];
    while (pending.length > 0) {
      const next = pending.pop() as string;
      if (next === start) {
        recursive.add(start);
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(...(edges.get(next) ?? []));
    }
  }
  return recursive;
}

/**
 * Normalizes Effect's JSON Schema output for providers: drops `$schema`/`$id`/`$comment`,
 * inlines every non-recursive `$ref` (some providers do not resolve `$defs`) and keeps `$defs`
 * only for recursive definitions.
 */
function normalizeJsonSchema(root: JsonRecord): JsonRecord {
  const defs = isRecord(root.$defs) ? root.$defs : {};
  const recursive = recursiveDefinitions(defs);

  const normalize = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(normalize);
    if (!isRecord(node)) return node;
    const name = defNameOf(node);
    if (name !== undefined && name in defs && !recursive.has(name)) {
      const { $ref: _ref, ...siblings } = node;
      return normalize({ ...(defs[name] as JsonRecord), ...siblings });
    }
    const out: JsonRecord = {};
    for (const [key, value] of Object.entries(node)) {
      if (DROPPED_KEYWORDS.has(key) || key === '$defs') continue;
      if (DATA_KEYWORDS.has(key)) {
        out[key] = value;
      } else if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
        out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
      } else {
        out[key] = normalize(value);
      }
    }
    return out;
  };

  // The root is always dereferenced so providers see `type: 'object'` at the top level.
  const rootName = defNameOf(root);
  const { $ref: _rootRef, ...rootSiblings } = root;
  const rootNode =
    rootName !== undefined && rootName in defs
      ? { ...(defs[rootName] as JsonRecord), ...rootSiblings }
      : root;
  const result = normalize(rootNode) as JsonRecord;
  if (recursive.size > 0) {
    result.$defs = Object.fromEntries([...recursive].map((name) => [name, normalize(defs[name])]));
  }
  return result;
}

/** `S.Struct({})`: Effect describes it as "any object or array"; providers need an object. */
function isEmptyStruct(schema: S.Schema.Any): boolean {
  const ast = SchemaAST.encodedAST(schema.ast);
  return (
    SchemaAST.isTypeLiteral(ast) &&
    ast.propertySignatures.length === 0 &&
    ast.indexSignatures.length === 0
  );
}

function emptyObjectSchema(raw: JsonRecord): JsonRecord {
  return {
    type: 'object',
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    required: [],
    properties: {},
    additionalProperties: false,
  };
}

/**
 * Derives the provider-ready JSON Schema of a tool's input. Runs at `define()` time and throws
 * a {@link ToolDefinitionError} when the schema cannot be sent to a provider.
 */
export function deriveToolJsonSchema(
  name: string,
  description: string,
  inputSchema: S.Schema.Any,
): ToolJsonSchema {
  let raw: JsonRecord;
  try {
    raw = JSONSchema.make(
      inputSchema as S.Schema<unknown, unknown, never>,
    ) as unknown as JsonRecord;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ToolDefinitionError(
      name,
      `Tool "${name}": input schema cannot be converted to JSON Schema, so it cannot be sent to ` +
        'an LLM. Use JSON-compatible schemas (e.g. S.Date instead of S.DateFromSelf) or add a ' +
        `"jsonSchema" annotation.\n${reason}`,
    );
  }
  const parameters = isEmptyStruct(inputSchema) ? emptyObjectSchema(raw) : normalizeJsonSchema(raw);
  if (parameters.type !== 'object') {
    throw new ToolDefinitionError(
      name,
      `Tool "${name}": input schema must be an object schema (e.g. S.Struct) because LLM ` +
        `providers require tool parameters to be a JSON object; got ${JSON.stringify(parameters)}.`,
    );
  }
  return { name, description, parameters: parameters as ToolParametersJsonSchema };
}

type HasJsonSchema = { toJsonSchema(): ToolJsonSchema };

/**
 * OpenAI Chat Completions function tool (`ChatCompletionFunctionTool` in `openai` v5/v6; also
 * accepted by most OpenAI-compatible APIs). `strict` is left unset: strict mode requires every
 * property to be required, which optional fields would violate.
 */
export type OpenAIFunctionTool = {
  type: 'function';
  function: { name: string; description: string; parameters: ToolParametersJsonSchema };
};

/** Anthropic Messages API custom tool (`Tool` in `@anthropic-ai/sdk`). */
export type AnthropicTool = {
  name: string;
  description: string;
  input_schema: ToolParametersJsonSchema;
};

/** The subset of the AI SDK's `ToolCallOptions` a tool uses. */
export type AiSdkToolCallOptions = { toolCallId: string; abortSignal?: AbortSignal };

/** A tool in the shape of AI SDK v5's `tool({ description, inputSchema, execute })`. */
export type AiSdkTool<TSchema, TOutput = unknown> = {
  description: string;
  inputSchema: TSchema;
  execute: (input: unknown, options: AiSdkToolCallOptions) => Promise<TOutput>;
};

/**
 * Helpers from the `ai` package the AI SDK formatter needs. Pass `{ jsonSchema }` imported from
 * `ai`; m4trix does not depend on the SDK, so it cannot create AI SDK schemas itself.
 */
export type AiSdkHelpers<TSchema> = {
  /**
   * Receives a {@link ToolParametersJsonSchema}. Typed `never` so the SDK's own signature
   * (which takes its `JSONSchema7` type) is accepted without m4trix depending on its types.
   */
  jsonSchema: (schema: never) => TSchema;
};

/** A bound tool as the AI SDK formatter needs it. */
type AiSdkBindableTool = HasJsonSchema & {
  execute(
    input: unknown,
    options?: { toolCallId?: string; signal?: AbortSignal },
  ): Promise<unknown>;
};

/** Formats tools for OpenAI Chat Completions `tools`. */
export function toOpenAITools(tools: ReadonlyArray<HasJsonSchema>): Array<OpenAIFunctionTool> {
  return tools.map((tool) => {
    const { name, description, parameters } = tool.toJsonSchema();
    return { type: 'function', function: { name, description, parameters } };
  });
}

/** Formats tools for the Anthropic Messages API `tools`. */
export function toAnthropicTools(tools: ReadonlyArray<HasJsonSchema>): Array<AnthropicTool> {
  return tools.map((tool) => {
    const { name, description, parameters } = tool.toJsonSchema();
    return { name, description, input_schema: parameters };
  });
}

/**
 * Formats bound tools as an AI SDK v5 `ToolSet` (`generateText({ tools })`). `execute` runs the
 * tool with the SDK's `toolCallId` and `abortSignal`, and rejects with the typed tool errors,
 * which the AI SDK reports back to the model as tool errors.
 */
export function toAiSdkTools<TSchema>(
  tools: ReadonlyArray<AiSdkBindableTool>,
  helpers: AiSdkHelpers<TSchema>,
): Record<string, AiSdkTool<TSchema>> {
  const toolSet: Record<string, AiSdkTool<TSchema>> = {};
  for (const tool of tools) {
    const { name, description, parameters } = tool.toJsonSchema();
    toolSet[name] = {
      description,
      inputSchema: helpers.jsonSchema(parameters as never),
      execute: (input, options) =>
        tool.execute(input, { toolCallId: options.toolCallId, signal: options.abortSignal }),
    };
  }
  return toolSet;
}
