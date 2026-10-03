import { describe, expect, it } from 'vitest';
import { computeCoverage } from './coverage';
import { STARTER_MAPPING } from './mapping-schema';
import {
  buildCreatePrompt,
  buildImprovePrompt,
  buildRepairPrompt,
  MAPPING_SYSTEM_PROMPT,
  parseModelAnswer,
} from './prompt';
import type { SampleGroup } from './sampling';

const group: SampleGroup = {
  key: 'tool · search · output',
  runType: 'tool',
  runName: 'search',
  side: 'output',
  runCount: 7,
  shape: '{ hits: Array<string> }',
  samples: [
    { traceId: 't', runId: 'r1', ref: 'x', payload: { hits: ['a'] }, original: { hits: ['a'] } },
  ],
};

describe('prompts', () => {
  it('system prompt documents the format and the response contract', () => {
    expect(MAPPING_SYSTEM_PROMPT).toContain('type PayloadMapping');
    expect(MAPPING_SYSTEM_PROMPT).toContain('"mapping": PayloadMapping');
  });

  it('create prompt includes the instruction, group header, shape and samples', () => {
    const prompt = buildCreatePrompt([group], '  tables please ');
    expect(prompt).toContain('User instruction: tables please');
    expect(prompt).toContain('runType="tool" name="search" side=output (7 runs)');
    expect(prompt).toContain('Shape: { hits: Array<string> }');
    expect(prompt).toContain('Sample 1 (run r1):\n{"hits":["a"]}');
    expect(buildCreatePrompt([group])).not.toContain('User instruction');
  });

  it('improve prompt includes the current mapping and coverage', () => {
    const coverage = computeCoverage(STARTER_MAPPING, [
      { run: { type: 'tool', name: 'search' }, side: 'output', payload: { hits: [] } },
    ]);
    const prompt = buildImprovePrompt(STARTER_MAPPING, coverage, [group]);
    expect(prompt).toContain(`Current mapping:\n${JSON.stringify(STARTER_MAPPING)}`);
    expect(prompt).toContain('Coverage of the current mapping (100%)');
    expect(prompt).toContain(
      '- tool · search · output: 1 mapped, 0 partial, 0 broken, 0 unmatched rules=[tool-output]',
    );
  });

  it('repair prompt lists the problems', () => {
    expect(buildRepairPrompt('{"x":1}', ['bad path'])).toContain('- bad path');
  });
});

describe('parseModelAnswer', () => {
  it('parses fenced, prose-wrapped and bare-mapping answers', () => {
    const wrapped = parseModelAnswer(
      'Here you go:\n```json\n{"name":"n","mapping":{"schemaVersion":1,"rules":[]},"changes":["a",1]}\n```',
    );
    expect(wrapped).toEqual({
      ok: true,
      answer: {
        name: 'n',
        description: undefined,
        mapping: { schemaVersion: 1, rules: [] },
        changes: ['a'],
      },
    });
    const bare = parseModelAnswer('{"schemaVersion":1,"rules":[]}');
    expect(bare.ok && bare.answer.mapping).toEqual({ schemaVersion: 1, rules: [] });
  });

  it('reports missing objects, invalid JSON and missing mappings', () => {
    expect(parseModelAnswer('nope')).toMatchObject({
      ok: false,
      error: expect.stringContaining('did not contain'),
    });
    expect(parseModelAnswer('{"mapping": ')).toMatchObject({ ok: false });
    expect(parseModelAnswer('{"foo":1}')).toMatchObject({
      ok: false,
      error: 'The answer has no "mapping" field.',
    });
  });
});
