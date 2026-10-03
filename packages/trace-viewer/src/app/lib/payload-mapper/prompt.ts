import type { CoverageReport } from './coverage';
import type { PayloadMapping } from './mapping-schema';
import type { SampleGroup } from './sampling';

export const MAPPING_FORMAT_SPEC = `type Path = string; // JSONPath subset: "$" (current scope), ".key", "['odd key']", "[0]", "[-1]", "[*]", ".*". No filters, no "..".

type RuleMatch = {
  runType?: string[];          // e.g. ["chat_model"], ["tool"]
  name?: string | string[];    // glob(s) on run name, "*" wildcard, case-insensitive
  side?: "input" | "output" | "both"; // default "both"
  metadata?: Record<string, string | number | boolean>; // exact equality on run metadata
  requires?: Path[];           // paths that must resolve to a non-null value
};

// Every view may set: title?: string; at?: Path (rebase scope to first match of this path).
type View =
  | { kind: "messages"; items: Path; role?: Path; content?: Path; name?: Path;
      toolCalls?: { items: Path; name?: Path; args?: Path; id?: Path };
      toolCallId?: Path; collapseRoles?: string[] }   // item paths are relative to each message
  | { kind: "toolCall"; name?: Path; args?: Path; id?: Path }
  | { kind: "toolResult"; name?: Path; status?: Path; content?: Path; body?: View }
  | { kind: "keyValue"; entries: { label: string; value: Path }[] }
  | { kind: "markdown"; value: Path }
  | { kind: "text"; value: Path }
  | { kind: "code"; value: Path; language?: string }
  | { kind: "table"; rows: Path; columns: { label: string; value: Path }[] } // column paths relative to each row
  | { kind: "json"; value?: Path }       // explicit raw JSON (use for payloads not worth structuring)
  | { kind: "stack"; children: View[] };

type PayloadMapping = {
  schemaVersion: 1;
  metadata?: { pick?: string[]; labels?: Record<string, string> }; // run metadata keys to show, in order
  rules: { id: string; description?: string; match: RuleMatch; view: View }[]; // first match wins
  usage?: { match?: RuleMatch; inputTokens?: Path; outputTokens?: Path; totalTokens?: Path;
            cachedTokens?: Path; costUsd?: Path; model?: Path }[]; // token/cost extraction for aggregates
};`;

export const MAPPING_SYSTEM_PROMPT = `You design display mappings for an LLM trace viewer. A trace is a tree of runs (chains, chat models, tools, …); each run has an input and an output JSON payload. A mapping turns those payloads into readable UI in the run detail panel: chat transcripts, tool calls with arguments, tool results, key/value summaries, markdown, code and tables.

The mapping format (TypeScript notation):

${MAPPING_FORMAT_SPEC}

How rendering works:
- For each payload, rules are tried in order and the first match renders. Unmatched payloads show as raw JSON.
- Paths in a view resolve against the payload (or against the "at" scope). Paths inside messages.* / toolCalls.* / table columns resolve against each item.
- "messages" understands common content shapes on its own: plain strings, Anthropic/OpenAI content-block arrays (text, thinking, tool_use, tool_result, image) and LangChain tool_calls ({name, args, id}) or OpenAI ({function: {name, arguments}}). Role strings are classified heuristically (human/user, ai/assistant, system, tool). If a configured role/content path misses for an item, it falls back to item.role/item.type and item.content.
- toolCall/toolResult "args"/"content" strings that contain JSON are parsed automatically.

Guidelines:
- Put specific rules (runType + name + side + requires) before generic ones. Always add "requires" for the paths a view depends on so rules don't match payloads of another shape.
- Prefer "messages" for anything that is a conversation; collapse long system prompts with collapseRoles: ["system"].
- Show tool inputs as toolCall and tool outputs as toolResult. Use "stack" to combine e.g. a completion and its usage.
- Use "json" rules for structural/bookkeeping payloads that are not worth a custom view, so they count as intentionally mapped.
- Add "usage" rules when token counts or model names appear in payloads (usually chat model outputs).
- Only reference paths you can see in the samples. Never invent fields.
- Rule ids are short kebab-case and unique.
- Samples are truncated: long strings end with "…‹+N chars›", long arrays end with an "‹+N more items›" marker string, and "‹redacted N chars›" replaces redacted strings. Do not match on those markers.

Respond with a single JSON object and nothing else (no markdown fences):
{ "name": string, "description": string, "mapping": PayloadMapping, "changes": string[] }
"changes" is a short list of what you did (or changed, when improving).`;

function renderGroups(groups: SampleGroup[]): string {
  return groups
    .map((g, i) => {
      const samples = g.samples
        .map((s, j) => `Sample ${j + 1} (run ${s.runId}):\n${JSON.stringify(s.payload)}`)
        .join('\n\n');
      return [
        `### Group ${i + 1}: runType=${JSON.stringify(g.runType)} name=${JSON.stringify(g.runName)} side=${g.side} (${g.runCount} runs)`,
        `Shape: ${g.shape}`,
        samples,
      ].join('\n');
    })
    .join('\n\n');
}

export function buildCreatePrompt(groups: SampleGroup[], instruction?: string): string {
  return [
    'Create a mapping for these payload groups.',
    instruction?.trim() ? `User instruction: ${instruction.trim()}` : '',
    renderGroups(groups),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function renderCoverage(report: CoverageReport): string {
  const lines = report.groups.map((g) => {
    const status = `${g.mapped} mapped, ${g.partial} partial, ${g.fallback} broken, ${g.unmatched} unmatched`;
    const rules = g.ruleIds.length > 0 ? ` rules=[${g.ruleIds.join(', ')}]` : '';
    const issues = g.issues.length > 0 ? `\n    issues: ${g.issues.join(' | ')}` : '';
    return `- ${g.key}: ${status}${rules}${issues}`;
  });
  return `Coverage of the current mapping (${Math.round(report.score * 100)}%):\n${lines.join('\n')}`;
}

export function buildImprovePrompt(
  current: PayloadMapping,
  coverage: CoverageReport,
  groups: SampleGroup[],
  instruction?: string,
): string {
  return [
    'Improve this existing mapping. Keep rules that work (and their ids) unless the instruction says otherwise; fix broken and partial rules, and add rules for unmatched groups. Return the complete revised mapping.',
    instruction?.trim() ? `User instruction: ${instruction.trim()}` : '',
    `Current mapping:\n${JSON.stringify(current)}`,
    renderCoverage(coverage),
    renderGroups(groups),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Follow-up sent after the (cached) base prompt when the previous answer was invalid. */
export function buildRepairPrompt(previousAnswer: string, problems: string[]): string {
  return [
    `Your previous answer:\n${previousAnswer}`,
    `It has these problems:\n${problems.map((p) => `- ${p}`).join('\n')}`,
    'Return the corrected full JSON object (same response format). Fix only what is needed.',
  ].join('\n\n');
}

export type ParsedAnswer = {
  name?: string;
  description?: string;
  mapping: unknown;
  changes: string[];
};

/** Extract the JSON object from a model answer (tolerates code fences and surrounding prose). */
export function parseModelAnswer(
  text: string,
): { ok: true; answer: ParsedAnswer } | { ok: false; error: string } {
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidate = fence[1].trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start)
    return { ok: false, error: 'The answer did not contain a JSON object.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch (err) {
    return { ok: false, error: `The answer is not valid JSON: ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'Expected a JSON object.' };
  const o = parsed as Record<string, unknown>;
  // Accept a bare mapping as well as the wrapped response format.
  const mapping = 'mapping' in o ? o.mapping : 'rules' in o ? o : undefined;
  if (mapping === undefined) return { ok: false, error: 'The answer has no "mapping" field.' };
  return {
    ok: true,
    answer: {
      name: typeof o.name === 'string' ? o.name : undefined,
      description: typeof o.description === 'string' ? o.description : undefined,
      mapping,
      changes: Array.isArray(o.changes)
        ? o.changes.filter((c): c is string => typeof c === 'string')
        : [],
    },
  };
}
