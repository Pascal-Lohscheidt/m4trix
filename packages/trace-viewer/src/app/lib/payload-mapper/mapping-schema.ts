import { z } from 'zod';
import { parsePath } from './json-path';

/** JSONPath subset string, evaluated relative to the current scope (see `json-path.ts`). */
export const pathSchema = z.string().superRefine((value, ctx) => {
  const parsed = parsePath(value);
  if (!parsed.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error });
});

const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);

export const ruleMatchSchema = z
  .object({
    /** Run types to match (e.g. `chat_model`, `tool`). Omit to match any type. */
    runType: z.array(z.string().min(1)).optional(),
    /** Glob(s) against the run name; `*` matches any characters. */
    name: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
    side: z.enum(['input', 'output', 'both']).optional(),
    /** Exact equality against run metadata values. */
    metadata: z.record(scalarSchema).optional(),
    /** Paths that must resolve to a non-null value in the payload. */
    requires: z.array(pathSchema).optional(),
  })
  .strict();

const toolCallsSchema = z
  .object({
    items: pathSchema,
    name: pathSchema.optional(),
    args: pathSchema.optional(),
    id: pathSchema.optional(),
  })
  .strict();

const labeledPathSchema = z.object({ label: z.string(), value: pathSchema }).strict();

const viewBase = {
  title: z.string().optional(),
  /** Rebase the scope to the first match of this path before resolving the view. */
  at: pathSchema.optional(),
};

export type MessagesView = {
  kind: 'messages';
  title?: string;
  at?: string;
  items: string;
  role?: string;
  content?: string;
  name?: string;
  toolCalls?: z.infer<typeof toolCallsSchema>;
  toolCallId?: string;
  /** Roles rendered collapsed by default (e.g. long system prompts). */
  collapseRoles?: string[];
};
export type ToolCallView = {
  kind: 'toolCall';
  title?: string;
  at?: string;
  name?: string;
  args?: string;
  id?: string;
};
export type ToolResultView = {
  kind: 'toolResult';
  title?: string;
  at?: string;
  name?: string;
  status?: string;
  content?: string;
  body?: MappingView;
};
export type KeyValueView = {
  kind: 'keyValue';
  title?: string;
  at?: string;
  entries: { label: string; value: string }[];
};
export type MarkdownView = { kind: 'markdown'; title?: string; at?: string; value: string };
export type TextView = { kind: 'text'; title?: string; at?: string; value: string };
export type CodeView = {
  kind: 'code';
  title?: string;
  at?: string;
  value: string;
  language?: string;
};
export type TableView = {
  kind: 'table';
  title?: string;
  at?: string;
  rows: string;
  columns: { label: string; value: string }[];
};
export type JsonView = { kind: 'json'; title?: string; at?: string; value?: string };
export type StackView = { kind: 'stack'; title?: string; at?: string; children: MappingView[] };

export type MappingView =
  | MessagesView
  | ToolCallView
  | ToolResultView
  | KeyValueView
  | MarkdownView
  | TextView
  | CodeView
  | TableView
  | JsonView
  | StackView;

export type MappingViewKind = MappingView['kind'];

export const viewSchema: z.ZodType<MappingView> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z
      .object({
        ...viewBase,
        kind: z.literal('messages'),
        items: pathSchema,
        role: pathSchema.optional(),
        content: pathSchema.optional(),
        name: pathSchema.optional(),
        toolCalls: toolCallsSchema.optional(),
        toolCallId: pathSchema.optional(),
        collapseRoles: z.array(z.string()).optional(),
      })
      .strict(),
    z
      .object({
        ...viewBase,
        kind: z.literal('toolCall'),
        name: pathSchema.optional(),
        args: pathSchema.optional(),
        id: pathSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...viewBase,
        kind: z.literal('toolResult'),
        name: pathSchema.optional(),
        status: pathSchema.optional(),
        content: pathSchema.optional(),
        body: viewSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...viewBase,
        kind: z.literal('keyValue'),
        entries: z.array(labeledPathSchema).min(1),
      })
      .strict(),
    z.object({ ...viewBase, kind: z.literal('markdown'), value: pathSchema }).strict(),
    z.object({ ...viewBase, kind: z.literal('text'), value: pathSchema }).strict(),
    z
      .object({
        ...viewBase,
        kind: z.literal('code'),
        value: pathSchema,
        language: z.string().optional(),
      })
      .strict(),
    z
      .object({
        ...viewBase,
        kind: z.literal('table'),
        rows: pathSchema,
        columns: z.array(labeledPathSchema).min(1),
      })
      .strict(),
    z.object({ ...viewBase, kind: z.literal('json'), value: pathSchema.optional() }).strict(),
    z
      .object({ ...viewBase, kind: z.literal('stack'), children: z.array(viewSchema).min(1) })
      .strict(),
  ]),
);

export const mappingRuleSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().optional(),
    match: ruleMatchSchema,
    view: viewSchema,
  })
  .strict();

export const usageRuleSchema = z
  .object({
    match: ruleMatchSchema.optional(),
    inputTokens: pathSchema.optional(),
    outputTokens: pathSchema.optional(),
    totalTokens: pathSchema.optional(),
    cachedTokens: pathSchema.optional(),
    costUsd: pathSchema.optional(),
    model: pathSchema.optional(),
  })
  .strict();

export const metadataConfigSchema = z
  .object({
    /** Metadata keys to show, in order. Omit to show all metadata as JSON. */
    pick: z.array(z.string().min(1)).optional(),
    labels: z.record(z.string()).optional(),
  })
  .strict();

export const payloadMappingSchema = z
  .object({
    schemaVersion: z.literal(1),
    metadata: metadataConfigSchema.optional(),
    rules: z.array(mappingRuleSchema),
    usage: z.array(usageRuleSchema).optional(),
  })
  .strict()
  .superRefine((mapping, ctx) => {
    const seen = new Set<string>();
    mapping.rules.forEach((rule, index) => {
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules', index, 'id'],
          message: `Duplicate rule id "${rule.id}"`,
        });
      }
      seen.add(rule.id);
    });
  });

export type RuleMatch = z.infer<typeof ruleMatchSchema>;
export type MappingRule = z.infer<typeof mappingRuleSchema>;
export type UsageRule = z.infer<typeof usageRuleSchema>;
export type MetadataConfig = z.infer<typeof metadataConfigSchema>;
export type PayloadMapping = z.infer<typeof payloadMappingSchema>;

export type MappingValidationResult =
  | { ok: true; mapping: PayloadMapping }
  | { ok: false; errors: string[] };

export function validateMapping(value: unknown): MappingValidationResult {
  const result = payloadMappingSchema.safeParse(value);
  if (result.success) return { ok: true, mapping: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${where}: ${issue.message}`;
    }),
  };
}

/** Starter mapping for new hand-written profiles. */
export const STARTER_MAPPING: PayloadMapping = {
  schemaVersion: 1,
  rules: [
    {
      id: 'chat-messages',
      description: 'Any payload with a top-level messages array.',
      match: { requires: ['$.messages'] },
      view: {
        kind: 'messages',
        items: '$.messages[*]',
        role: '$.type',
        content: '$.content',
        toolCalls: { items: '$.tool_calls[*]', name: '$.name', args: '$.args', id: '$.id' },
        collapseRoles: ['system'],
      },
    },
    {
      id: 'tool-output',
      match: { runType: ['tool'], side: 'output' },
      view: { kind: 'toolResult', content: '$' },
    },
  ],
};
