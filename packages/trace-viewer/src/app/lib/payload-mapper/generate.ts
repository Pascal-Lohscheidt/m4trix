import { type CoverageReport, coverageForSamples } from './coverage';
import { type PayloadMapping, validateMapping } from './mapping-schema';
import {
  buildCreatePrompt,
  buildImprovePrompt,
  buildRepairPrompt,
  MAPPING_SYSTEM_PROMPT,
  parseModelAnswer,
} from './prompt';
import type { MapperProvider } from './providers/types';
import type { SampleGroup } from './sampling';

export type GenerationMode = 'create' | 'improve';

export type GenerationEvent =
  | { type: 'request'; attempt: number; repair: boolean }
  | { type: 'response'; attempt: number; outputTokens?: number }
  | { type: 'problems'; attempt: number; problems: string[] };

export type GenerationInput = {
  provider: MapperProvider;
  mode: GenerationMode;
  groups: SampleGroup[];
  /** Required when improving. */
  current?: PayloadMapping;
  /** Samples kept from earlier versions; checked for regressions but not sent. */
  regressionGroups?: SampleGroup[];
  instruction?: string;
  maxRepairs?: number;
  signal?: AbortSignal;
  onProgress?: (event: GenerationEvent) => void;
};

export type GenerationAttempt = { attempt: number; problems: string[]; outputTokens?: number };

export type GenerationResult = {
  mapping: PayloadMapping;
  name?: string;
  description?: string;
  changes: string[];
  /** New mapping on the sampled (+ regression) payloads. */
  coverage: CoverageReport;
  /** Current mapping on the same payloads (improve mode). */
  before?: CoverageReport;
  attempts: GenerationAttempt[];
  usage: { inputTokens: number; outputTokens: number };
  /** Problems that were still present after the last repair attempt. */
  unresolved: string[];
};

export class GenerationError extends Error {
  readonly attempts: GenerationAttempt[];
  readonly lastAnswer: string;

  constructor(message: string, attempts: GenerationAttempt[], lastAnswer: string) {
    super(message);
    this.name = 'GenerationError';
    this.attempts = attempts;
    this.lastAnswer = lastAnswer;
  }
}

/**
 * Problems worth a repair round: broken views (rule matched, view could not resolve) and,
 * when improving, groups that rendered before but no longer do. Unmatched groups and partial
 * paths are reported in coverage but do not trigger repairs.
 */
export function dryRunProblems(after: CoverageReport, before?: CoverageReport): string[] {
  const problems: string[] = [];
  for (const g of after.groups) {
    if (g.fallback > 0) {
      problems.push(
        `Rule(s) ${g.ruleIds.join(', ') || '?'} matched "${g.key}" but could not render ${g.fallback}/${g.total} samples: ${g.issues.join(' | ')}`,
      );
    }
  }
  if (before) {
    const prev = new Map(before.groups.map((g) => [g.key, g]));
    for (const g of after.groups) {
      const old = prev.get(g.key);
      if (!old) continue;
      const okBefore = old.mapped + old.partial;
      const okAfter = g.mapped + g.partial;
      if (okAfter < okBefore) {
        problems.push(
          `Regression on "${g.key}": ${okBefore}/${old.total} samples rendered before, now ${okAfter}/${g.total}.`,
        );
      }
    }
  }
  return problems;
}

export async function runMappingGeneration(input: GenerationInput): Promise<GenerationResult> {
  const { provider, mode, groups, current, instruction, signal, onProgress } = input;
  if (mode === 'improve' && !current) throw new Error('Improving requires the current mapping.');
  const maxRepairs = input.maxRepairs ?? 2;
  const checkGroups = [...groups, ...(input.regressionGroups ?? [])];
  const before =
    mode === 'improve' && current ? coverageForSamples(current, checkGroups) : undefined;

  const basePrompt =
    mode === 'improve' && current && before
      ? buildImprovePrompt(current, coverageForSamples(current, groups), groups, instruction)
      : buildCreatePrompt(groups, instruction);

  const attempts: GenerationAttempt[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let prompt = '';
  let lastAnswer = '';
  let best: Omit<GenerationResult, 'attempts' | 'usage' | 'unresolved' | 'before'> | null = null;
  let bestProblems: string[] = [];

  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    onProgress?.({ type: 'request', attempt, repair: attempt > 1 });
    const result = await provider.generate({
      system: MAPPING_SYSTEM_PROMPT,
      cacheablePrefix: basePrompt,
      prompt,
      signal,
    });
    lastAnswer = result.text;
    usage.inputTokens += result.usage?.inputTokens ?? 0;
    usage.outputTokens += result.usage?.outputTokens ?? 0;
    onProgress?.({ type: 'response', attempt, outputTokens: result.usage?.outputTokens });

    let problems: string[];
    const parsed = parseModelAnswer(result.text);
    if (!parsed.ok) {
      problems = [parsed.error];
    } else {
      const validation = validateMapping(parsed.answer.mapping);
      if (!validation.ok) {
        problems = validation.errors.slice(0, 20);
      } else {
        const coverage = coverageForSamples(validation.mapping, checkGroups);
        problems = dryRunProblems(coverage, before);
        // Keep the best valid candidate (fewest problems) in case repairs don't converge.
        if (!best || problems.length < bestProblems.length) {
          best = {
            mapping: validation.mapping,
            name: parsed.answer.name,
            description: parsed.answer.description,
            changes: parsed.answer.changes,
            coverage,
          };
          bestProblems = problems;
        }
      }
    }

    attempts.push({ attempt, problems, outputTokens: result.usage?.outputTokens });
    if (problems.length === 0) break;
    onProgress?.({ type: 'problems', attempt, problems });
    if (attempt <= maxRepairs) prompt = buildRepairPrompt(result.text, problems);
  }

  if (!best) {
    const last = attempts[attempts.length - 1];
    throw new GenerationError(
      `The model did not return a valid mapping after ${attempts.length} attempt(s): ${last?.problems[0] ?? 'unknown error'}`,
      attempts,
      lastAnswer,
    );
  }
  return { ...best, before, attempts, usage, unresolved: bestProblems };
}
