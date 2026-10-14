import { describe, expect, expectTypeOf, test } from 'vitest';
import type * as Root from '../../index.js';
import * as root from '../../index.js';
import type { EventEnvelope } from '../agent-factory.js';
import { AgentNetworkEvent, S } from '../agent-network/agent-network-event.js';
import type * as Matrix from '../index.js';
import * as matrix from '../index.js';
import {
  type AnyContextFold,
  ContextFold,
  ContextFoldDefinitionError,
  type FoldStateOf,
} from './context-fold.js';
import {
  type AnySegmentedState,
  type CheckpointOf,
  type Segment,
  type SegmentDataOf,
  SegmentedFold,
  type SegmentedFoldBuilder,
  type SegmentedFoldEventsBuilder,
  type SegmentedState,
  type SegmentOf,
} from './segmented-fold.js';

/* ─── Fixtures ─── */

const UserPrompt = AgentNetworkEvent.of('user-prompt', S.Struct({ text: S.String }));
const ModelStep = AgentNetworkEvent.of(
  'model-step',
  S.Struct({ stepId: S.String, text: S.String }),
);
const ToolResult = AgentNetworkEvent.of(
  'tool-result',
  S.Struct({ stepId: S.String, callId: S.String, output: S.String }),
);
const Entry = S.Union(
  S.Struct({ kind: S.Literal('user'), text: S.String }),
  S.Struct({
    kind: S.Literal('step'),
    text: S.String,
    results: S.Array(S.Struct({ callId: S.String, output: S.String })),
  }),
);
type Entry = typeof Entry.Type;
const ContextCompacted = AgentNetworkEvent.of(
  'context-compacted',
  S.Struct({
    summary: S.String,
    kept: S.Array(S.Struct({ id: S.String, data: Entry })),
  }),
);

type State = SegmentedState<Entry, string>;

const meta = { runId: 'run-1', contextId: 'ctx-1' };
const prompt = (text: string, runId = 'run-1') =>
  UserPrompt.makeBound({ ...meta, runId }, { text });
const step = (stepId: string, text: string) => ModelStep.makeBound(meta, { stepId, text });
const toolResult = (stepId: string, callId: string, output: string) =>
  ToolResult.makeBound(meta, { stepId, callId, output });

/** The m4trix-code conversation: prompts and steps open segments, tool results attach. */
const conversation = () =>
  SegmentedFold.of('conversation', { version: 1 })
    .over([UserPrompt, ModelStep, ToolResult, ContextCompacted])
    .segments<Entry, string>()
    .on(UserPrompt, (state, { meta, payload }) =>
      SegmentedFold.open(state, `prompt:${meta.runId}`, { kind: 'user', text: payload.text }),
    )
    .on(ModelStep, (state, { payload }) =>
      SegmentedFold.open(state, payload.stepId, { kind: 'step', text: payload.text, results: [] }),
    )
    .on(ToolResult, (state, { payload }) =>
      SegmentedFold.attach(state, payload.stepId, (data) =>
        data.kind === 'step'
          ? {
              ...data,
              results: [...data.results, { callId: payload.callId, output: payload.output }],
            }
          : data,
      ),
    )
    .checkpointOn(ContextCompacted, ({ payload }) => ({
      checkpoint: payload.summary,
      segments: payload.kept,
    }));

describe('SegmentedFold.of', () => {
  test('builds a ContextFold whose initial state is an empty segment list', () => {
    const fold = SegmentedFold.of('conversation', { version: 3 })
      .over([UserPrompt])
      .segments<Entry>()
      .on(UserPrompt, (state) => state);

    expect(fold.name).toBe('conversation');
    expect(fold.version).toBe(3);
    expect(fold.scope).toBe('context');
    expect(fold.eventNames).toEqual(['user-prompt']);
    expect(fold.initialState()).toEqual({ segments: [] });
    expect(fold.initialState()).not.toBe(fold.initialState());
    expect(() => ContextFold.validate(fold)).not.toThrow();
    expectTypeOf(fold).toExtend<AnyContextFold>();
    expectTypeOf<FoldStateOf<typeof fold>>().toEqualTypeOf<SegmentedState<Entry>>();
  });

  test('takes a run scope before or after over()', () => {
    const before = SegmentedFold.of('steps', { version: 1 })
      .scope('run')
      .over([ModelStep])
      .segments<string>();
    const after = SegmentedFold.of('steps', { version: 1 })
      .over([ModelStep])
      .scope('run')
      .segments<string>();

    expect(before.scope).toBe('run');
    expect(after.scope).toBe('run');
    expectTypeOf(before.scope).toEqualTypeOf<'run'>();
    expectTypeOf(after.scope).toEqualTypeOf<'run'>();
  });

  test('the state type comes from segments<Data, Checkpoint>(), no initial() annotation needed', () => {
    const fold = conversation();

    expectTypeOf<FoldStateOf<typeof fold>>().toEqualTypeOf<State>();
    expectTypeOf<SegmentOf<State>>().toEqualTypeOf<Segment<Entry>>();
    expectTypeOf<SegmentDataOf<State>>().toEqualTypeOf<Entry>();
    expectTypeOf(fold.initialState().checkpoint).toEqualTypeOf<string | undefined>();
    expectTypeOf(fold.initialState().segments).toEqualTypeOf<ReadonlyArray<Segment<Entry>>>();
  });

  test('validates like ContextFold.of: name, version, scope and over() events', () => {
    const errors = [
      // @ts-expect-error - a fold name must be a JS identifier (it is a ctx.folds key)
      () => SegmentedFold.of('chat-view', { version: 1 }),
      () => SegmentedFold.of('conversation', { version: 0 }),
      // @ts-expect-error - only 'context' and 'run' are scopes
      () => SegmentedFold.of('conversation', { version: 1 }).scope('session'),
      () => SegmentedFold.of('conversation', { version: 1 }).over([]),
      // @ts-expect-error - segments() is only available after over()
      () => SegmentedFold.of('conversation', { version: 1 }).segments(),
    ];

    for (const build of errors) expect(build).toThrow(ContextFoldDefinitionError);
  });

  test('a segmented builder without segments() is rejected by ContextFold.validate', () => {
    const builder = SegmentedFold.of('conversation', { version: 1 }).over([UserPrompt]);

    expect(() => ContextFold.validate(builder)).toThrow(
      '"conversation" is not a fold source: pass a ContextFold or a view of one.',
    );
  });

  test('handlers get the segmented state and the typed envelope', () => {
    SegmentedFold.of('conversation', { version: 1 })
      .over([UserPrompt])
      .segments<Entry, string>()
      .on(UserPrompt, (state, envelope) => {
        expectTypeOf(state).toEqualTypeOf<State>();
        expectTypeOf(envelope).toEqualTypeOf<EventEnvelope<typeof UserPrompt>>();
        return state;
      });
  });
});

describe('SegmentedFold.open', () => {
  test('appends a segment, keeping the checkpoint and the previous state untouched', () => {
    const before: State = { checkpoint: 'summary', segments: [] };

    const after = SegmentedFold.open(before, 'p1', { kind: 'user', text: 'hi' });

    expect(after).toEqual({
      checkpoint: 'summary',
      segments: [{ id: 'p1', data: { kind: 'user', text: 'hi' } }],
    });
    expect(before.segments).toEqual([]);
    expectTypeOf(after).toEqualTypeOf<State>();
  });

  test('a repeated id opens another segment (ids should be unique)', () => {
    const once = SegmentedFold.open<State>({ segments: [] }, 's1', { kind: 'user', text: 'a' });
    const twice = SegmentedFold.open(once, 's1', { kind: 'user', text: 'b' });

    expect(twice.segments.map((segment) => segment.data)).toEqual([
      { kind: 'user', text: 'a' },
      { kind: 'user', text: 'b' },
    ]);
  });

  test('the data must be the segment data type of the state', () => {
    const state: State = { segments: [] };

    // @ts-expect-error - 'answer' is not a kind of Entry
    void (() => SegmentedFold.open(state, 'x', { kind: 'answer', text: 'done' }));
    // @ts-expect-error - a step needs its results
    void (() => SegmentedFold.open(state, 'x', { kind: 'step', text: 'ls' }));
    expect(state.segments).toEqual([]);
  });
});

describe('SegmentedFold.attach', () => {
  const opened = (): State => ({
    segments: [
      { id: 'p1', data: { kind: 'user', text: 'list files' } },
      { id: 's1', data: { kind: 'step', text: 'calling ls', results: [] } },
    ],
  });

  test('updates the data of the segment with that id, in place, with the typed data', () => {
    const before = opened();

    const after = SegmentedFold.attach(before, 's1', (data, segment) => {
      expectTypeOf(data).toEqualTypeOf<Entry>();
      expectTypeOf(segment).toEqualTypeOf<Segment<Entry>>();
      expect(segment.id).toBe('s1');
      return data.kind === 'step' ? { ...data, results: [{ callId: 'c1', output: 'a.ts' }] } : data;
    });

    expect(after.segments.map((segment) => segment.id)).toEqual(['p1', 's1']);
    expect(after.segments[1]?.data).toEqual({
      kind: 'step',
      text: 'calling ls',
      results: [{ callId: 'c1', output: 'a.ts' }],
    });
    expect(after.segments[0]).toBe(before.segments[0]);
    expect(before.segments[1]?.data).toEqual({ kind: 'step', text: 'calling ls', results: [] });
    expectTypeOf(after).toEqualTypeOf<State>();
  });

  test('attaches to the newest segment when an id was opened twice', () => {
    const state = SegmentedFold.open(opened(), 's1', { kind: 'user', text: 'again' });

    const after = SegmentedFold.attach(state, 's1', () => ({ kind: 'user', text: 'updated' }));

    expect(after.segments.map((segment) => segment.data)).toEqual([
      { kind: 'user', text: 'list files' },
      { kind: 'step', text: 'calling ls', results: [] },
      { kind: 'user', text: 'updated' },
    ]);
  });

  test('ignores an unknown id: the state is returned unchanged (same reference)', () => {
    const state = opened();
    let called = false;

    const after = SegmentedFold.attach(state, 'compacted-away', (data) => {
      called = true;
      return data;
    });

    expect(after).toBe(state);
    expect(called).toBe(false);
  });

  test('returns the same state when the update returns the same data', () => {
    const state = opened();

    expect(SegmentedFold.attach(state, 's1', (data) => data)).toBe(state);
  });
});

describe('a segmented conversation', () => {
  test('folds prompts, steps and their tool results into atomic segments', () => {
    const fold = conversation();

    const state = fold.applyAll(fold.initialState(), [
      prompt('list files'),
      step('s1', 'calling ls and cat'),
      toolResult('s1', 'c1', 'a.ts b.ts'),
      toolResult('s1', 'c2', 'export {}'),
      toolResult('unknown-step', 'c3', 'ignored'),
    ]);

    expect(state).toEqual({
      segments: [
        { id: 'prompt:run-1', data: { kind: 'user', text: 'list files' } },
        {
          id: 's1',
          data: {
            kind: 'step',
            text: 'calling ls and cat',
            results: [
              { callId: 'c1', output: 'a.ts b.ts' },
              { callId: 'c2', output: 'export {}' },
            ],
          },
        },
      ],
    });
  });

  test('a checkpoint restores the summary and the kept segments; later events fold on top', () => {
    const fold = conversation();
    const kept: Segment<Entry> = { id: 'prompt:run-2', data: { kind: 'user', text: 'second' } };

    const state = fold.applyAll(fold.initialState(), [
      prompt('first'),
      step('s1', 'long step'),
      prompt('second', 'run-2'),
      ContextCompacted.makeBound(meta, { summary: 'asked first, got a long step', kept: [kept] }),
      step('s2', 'answering second'),
      toolResult('s1', 'c1', 'late result of a compacted step'),
    ]);

    expect(state).toEqual({
      checkpoint: 'asked first, got a long step',
      segments: [kept, { id: 's2', data: { kind: 'step', text: 'answering second', results: [] } }],
    });
  });
});

describe('exports', () => {
  test('SegmentedFold and its types are exported by name from both entry points', () => {
    for (const entry of [root, matrix]) expect(entry.SegmentedFold).toBe(SegmentedFold);
    type Over = typeof UserPrompt;
    expectTypeOf<Root.Segment<number>>().toEqualTypeOf<Segment<number>>();
    expectTypeOf<Matrix.Segment<number>>().toEqualTypeOf<Segment<number>>();
    expectTypeOf<Root.SegmentedState<number, string>>().toEqualTypeOf<
      SegmentedState<number, string>
    >();
    expectTypeOf<Matrix.AnySegmentedState>().toEqualTypeOf<AnySegmentedState>();
    expectTypeOf<Root.AnySegmentedState>().toEqualTypeOf<AnySegmentedState>();
    expectTypeOf<Root.SegmentOf<State>>().toEqualTypeOf<SegmentOf<State>>();
    expectTypeOf<Matrix.SegmentDataOf<State>>().toEqualTypeOf<SegmentDataOf<State>>();
    expectTypeOf<Root.SegmentDataOf<State>>().toEqualTypeOf<Entry>();
    expectTypeOf<Root.CheckpointOf<State>>().toEqualTypeOf<CheckpointOf<State>>();
    expectTypeOf<Matrix.CheckpointOf<State>>().toEqualTypeOf<string>();
    expectTypeOf<Root.SegmentedFoldBuilder<'a'>>().toEqualTypeOf<SegmentedFoldBuilder<'a'>>();
    expectTypeOf<Matrix.SegmentedFoldBuilder<'a'>>().toEqualTypeOf<SegmentedFoldBuilder<'a'>>();
    expectTypeOf<Root.SegmentedFoldEventsBuilder<'a', 'run', Over>>().toEqualTypeOf<
      SegmentedFoldEventsBuilder<'a', 'run', Over>
    >();
    expectTypeOf<Matrix.SegmentedFoldEventsBuilder<'a', 'run', Over>>().toEqualTypeOf<
      SegmentedFoldEventsBuilder<'a', 'run', Over>
    >();
  });
});
