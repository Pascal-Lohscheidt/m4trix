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
  type ContextFoldBase,
  ContextFoldDefinitionError,
  type DuplicateFoldHandler,
  type FoldSkip,
  type FoldStateOf,
  foldStoredEvents,
} from './context-fold.js';
import type { FoldCheckpointEventName } from './fold-checkpoint.js';
import {
  type AnySegmentedFold,
  type AnySegmentedState,
  type InvalidSegmentTag,
  type KindNeedsSegmentTag,
  type Segment,
  type SegmentAttachOptions,
  type SegmentDataOf,
  type SegmentDataOfKind,
  SegmentedFold,
  type SegmentedFoldOptions,
  type SegmentedState,
  type SegmentKindOf,
  type SegmentOf,
  type SegmentTagOf,
  type SummaryOf,
  type ValidSegmentTag,
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
const Retracted = AgentNetworkEvent.of('retracted', S.Struct({ id: S.String }));

/** A prompt or a model step with the results of its tool calls. */
const Entry = S.Union(
  S.Struct({ kind: S.Literal('user'), text: S.String }),
  S.Struct({
    kind: S.Literal('step'),
    text: S.String,
    results: S.Array(S.Struct({ callId: S.String, output: S.String })),
  }),
);
type Entry = typeof Entry.Type;
type Step = Extract<Entry, { kind: 'step' }>;
type State = SegmentedState<Entry, string>;

const meta = { runId: 'run-1', contextId: 'ctx-1' };
const prompt = (text: string, runId = 'run-1') =>
  UserPrompt.makeBound({ ...meta, runId }, { text });
const step = (stepId: string, text: string) => ModelStep.makeBound(meta, { stepId, text });
const toolResult = (stepId: string, callId: string, output: string) =>
  ToolResult.makeBound(meta, { stepId, callId, output });

/** The m4trix-code conversation: prompts and steps open segments, tool results attach. */
const conversation = () =>
  SegmentedFold.of('conversation', { data: Entry, summary: S.String, tag: 'kind' })
    .open(UserPrompt, ({ meta, payload }) => ({
      id: `prompt:${meta.runId}`,
      data: { kind: 'user', text: payload.text },
    }))
    .open(ModelStep, ({ payload }) => ({
      id: payload.stepId,
      data: { kind: 'step', text: payload.text, results: [] },
    }))
    .attach(ToolResult, {
      kind: 'step',
      to: ({ payload }) => payload.stepId,
      update: (step, { payload }) => ({
        ...step,
        results: [...step.results, { callId: payload.callId, output: payload.output }],
      }),
    });

const user = (id: string, text: string): Segment<Entry> => ({ id, data: { kind: 'user', text } });
const stepSegment = (id: string, text: string, results: Step['results'] = []): Segment<Entry> => ({
  id,
  data: { kind: 'step', text, results },
});

/** Runs `build` and returns the `ContextFoldDefinitionError` it throws. */
function definitionError(build: () => unknown): ContextFoldDefinitionError {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(ContextFoldDefinitionError);
    return error as ContextFoldDefinitionError;
  }
  throw new Error('expected a ContextFoldDefinitionError');
}

/* ─── Specs ─── */

describe('SegmentedFold.of', () => {
  test('builds a fold from schemas: the state is SegmentedState<data, summary>, no segments yet', () => {
    const fold = conversation();

    expect(fold.name).toBe('conversation');
    expect(fold.version).toBe(1);
    expect(fold.scope).toBe('context');
    expect(fold.eventNames).toEqual(['user-prompt', 'model-step', 'tool-result']);
    // Every segmented fold has a state schema, so a context-scoped one can compact.
    expect(fold.checkpointEventName).toBe('m4trix:fold.checkpoint:conversation@1');
    expectTypeOf(fold.checkpointEventName).toEqualTypeOf<FoldCheckpointEventName<'conversation'>>();
    expect(fold.initialState()).toEqual({ segments: [] });
    expect(fold.initialState()).not.toBe(fold.initialState());
    expect(() => ContextFold.validate(fold)).not.toThrow();

    expectTypeOf<FoldStateOf<typeof fold>>().toEqualTypeOf<State>();
    expectTypeOf(fold.initialState().summary).toEqualTypeOf<string | undefined>();
    expectTypeOf(fold.initialState().segments).toEqualTypeOf<ReadonlyArray<Segment<Entry>>>();
    expectTypeOf(fold).toExtend<AnyContextFold>();
  });

  test('without a summary schema the state has no summary', () => {
    const fold = SegmentedFold.of('notes', { data: S.String }).open(UserPrompt, ({ payload }) => ({
      id: payload.text,
      data: payload.text,
    }));

    expectTypeOf<FoldStateOf<typeof fold>>().toEqualTypeOf<SegmentedState<string>>();
    expectTypeOf<SummaryOf<FoldStateOf<typeof fold>>>().toEqualTypeOf<never>();
    expect(fold.applyAll(fold.initialState(), [prompt('a')])).toEqual({
      segments: [{ id: 'a', data: 'a' }],
    });
  });

  test('exposes its tag, typed: the data field kinds are read from, kept by every step', () => {
    const tagged = conversation();
    const untagged = SegmentedFold.of('notes', { data: S.String });
    const opened = untagged.open(UserPrompt, ({ payload }) => ({ id: 'n', data: payload.text }));

    expect(tagged.tag).toBe('kind');
    expect(untagged.tag).toBe('_tag');
    expect(opened.tag).toBe('_tag');
    expectTypeOf(tagged.tag).toEqualTypeOf<'kind'>();
    expectTypeOf(opened.tag).toEqualTypeOf<'_tag'>();
  });

  test('every segmented fold is an AnySegmentedFold of its data and tag; a ContextFold is not', () => {
    const plain = ContextFold.of('plain')
      .initial((): State => ({ segments: [] }))
      .on(UserPrompt, (state) => state);

    expectTypeOf(conversation()).toExtend<AnySegmentedFold<Entry, 'kind'>>();
    expectTypeOf(conversation()).toExtend<AnySegmentedFold>();
    expectTypeOf(conversation()).toExtend<AnyContextFold>();
    expectTypeOf(plain).not.toExtend<AnySegmentedFold>();
    expectTypeOf<AnySegmentedFold<Entry, 'kind'>['tag']>().toEqualTypeOf<'kind'>();
    expect(plain.name).toBe('plain');
  });

  test('scope and version are options, as in ContextFold.of', () => {
    const run = SegmentedFold.of('steps', { data: S.String, scope: 'run', version: 2 });
    const defaults = SegmentedFold.of('steps', { data: S.String });

    expect([run.scope, run.version]).toEqual(['run', 2]);
    expect([defaults.scope, defaults.version]).toEqual(['context', 1]);
    // A run-scoped fold cannot compact: it has no checkpoint event.
    expect(run.checkpointEventName).toBeUndefined();
    expect(defaults.checkpointEventName).toBe('m4trix:fold.checkpoint:steps@1');
    expectTypeOf(run.checkpointEventName).toEqualTypeOf<undefined>();
    expectTypeOf(run.scope).toEqualTypeOf<'run'>();
    expectTypeOf(defaults.scope).toEqualTypeOf<'context'>();
  });

  test('stateSchema is derived from the data and summary schemas: it describes the state', () => {
    const fold = conversation();
    const state = fold.applyAll(fold.initialState(), [
      prompt('list files'),
      step('s1', 'calling ls'),
      toolResult('s1', 'c1', 'a.ts'),
    ]);
    const noSummary = SegmentedFold.of('notes', { data: S.String });

    expect(S.decodeUnknownSync(fold.stateSchema)(state)).toEqual(state);
    expect(S.is(fold.stateSchema)({ segments: [user('p', 'hi'), stepSegment('s', 'ls')] })).toBe(
      true,
    );
    expect(S.is(fold.stateSchema)({ segments: [{ id: 'p', data: { kind: 'tool' } }] })).toBe(false);
    expect(S.is(fold.stateSchema)({ summary: 1, segments: [] })).toBe(false);
    expect(S.is(noSummary.stateSchema)({ segments: [{ id: 'n', data: 'note' }] })).toBe(true);
    expect(S.is(noSummary.stateSchema)({ segments: [{ id: 'n', data: 1 }] })).toBe(false);
    expectTypeOf(fold.stateSchema).toEqualTypeOf<
      S.Schema<State, SegmentedState<typeof Entry.Encoded, string>>
    >();
  });

  test('stateSchema is S.Schema<state, encoded state>: transforming schemas encode', () => {
    const Timed = S.Struct({ at: S.NumberFromString });
    const fold = SegmentedFold.of('timed', { data: Timed, summary: S.NumberFromString }).open(
      UserPrompt,
      ({ payload }) => ({ id: payload.text, data: { at: payload.text.length } }),
    );

    const state = fold.applyAll({ summary: 7, segments: [] }, [prompt('abc')]);

    expect(S.encodeSync(fold.stateSchema)(state)).toEqual({
      summary: '7',
      segments: [{ id: 'abc', data: { at: '3' } }],
    });
    expectTypeOf(fold.stateSchema).toEqualTypeOf<
      S.Schema<
        SegmentedState<{ readonly at: number }, number>,
        SegmentedState<{ readonly at: string }, string>
      >
    >();
    expectTypeOf(SegmentedFold.of('timed', { data: Timed })).toEqualTypeOf<
      SegmentedFold<
        'timed',
        'context',
        { readonly at: number },
        never,
        '_tag',
        never,
        SegmentedState<{ readonly at: string }, never>
      >
    >();
  });

  test('every step returns a new fold and leaves the previous one as it was', () => {
    const base = SegmentedFold.of('conversation', { data: Entry, tag: 'kind' });
    const opened = base.open(UserPrompt, ({ payload }) => ({
      id: payload.text,
      data: { kind: 'user', text: payload.text },
    }));
    const attached = opened.attach(ToolResult, {
      to: ({ payload }) => payload.stepId,
      update: (data) => data,
    });
    const handled = attached.on(Retracted, (state) => state);

    expect(new Set([base, opened, attached, handled]).size).toBe(4);
    expect(base.eventNames).toEqual([]);
    expect(opened.eventNames).toEqual(['user-prompt']);
    expect(attached.eventNames).toEqual(['user-prompt', 'tool-result']);
    expect(handled.eventNames).toEqual(['user-prompt', 'tool-result', 'retracted']);
    expect(handled.checkpointEventName).toBe(base.checkpointEventName);
  });

  test('validates the name, version, scope and the data, summary and tag options', () => {
    const cases: Array<[() => unknown, string]> = [
      [
        // @ts-expect-error - a fold name must be a JS identifier (it is a ctx.folds key)
        () => SegmentedFold.of('chat-view', { data: Entry }),
        'SegmentedFold "chat-view": the name must be a JS identifier (letters, digits, `_` and ' +
          '`$`, not starting with a digit): it is the accessor name in `ctx.folds`.',
      ],
      [
        () => SegmentedFold.of('notes', { data: Entry, version: 0 }),
        'SegmentedFold "notes": version must be a positive integer; got 0.',
      ],
      [
        // @ts-expect-error - only 'context' and 'run' are scopes
        () => SegmentedFold.of('notes', { data: Entry, scope: 'session' }),
        `SegmentedFold "notes": unknown scope "session"; use 'context' or 'run'.`,
      ],
      [
        // @ts-expect-error - the data schema is required
        () => SegmentedFold.of('notes'),
        'SegmentedFold "notes": the data option must be an Effect schema of the segment data, ' +
          'e.g. S.Union(S.TaggedStruct(...), ...).',
      ],
      [
        // @ts-expect-error - the data is described by an Effect schema
        () => SegmentedFold.of('notes', { data: { kind: 'user' } }),
        'SegmentedFold "notes": the data option must be an Effect schema of the segment data, ' +
          'e.g. S.Union(S.TaggedStruct(...), ...).',
      ],
      [
        // @ts-expect-error - so is the summary
        () => SegmentedFold.of('notes', { data: Entry, summary: 'a summary' }),
        'SegmentedFold "notes": the summary option must be an Effect schema (or left out).',
      ],
      [
        // @ts-expect-error - the tag is a field name
        () => SegmentedFold.of('notes', { data: Entry, tag: 1 }),
        'SegmentedFold "notes": the tag option must name the field that tells the variants of ' +
          "the data apart (default '_tag'), e.g. 'kind'.",
      ],
    ];

    for (const [build, message] of cases) expect(definitionError(build).message).toBe(message);
  });

  test('a segmented fold without events is rejected like any fold', () => {
    const fold = SegmentedFold.of('empty', { data: S.String });

    const error = definitionError(() => ContextFold.validate(fold));

    expect(error.message).toBe(
      'SegmentedFold "empty": it folds no events; add a handler (.open(), .attach() or .on()).',
    );
    expect(definitionError(() => fold.initialState()).message).toBe(error.message);
  });
});

describe('SegmentedFold#open', () => {
  test('appends a segment { id, data } per event, newest last; the envelope is typed', () => {
    const fold = SegmentedFold.of('notes', { data: Entry, summary: S.String }).open(
      UserPrompt,
      (envelope) => {
        expectTypeOf(envelope).toEqualTypeOf<EventEnvelope<typeof UserPrompt>>();
        return { id: `${envelope.meta.runId}:${envelope.payload.text}`, data: user('', '').data };
      },
    );
    const before: State = { summary: 'summary', segments: [user('p0', 'earlier')] };

    const after = fold.applyAll(before, [prompt('a'), prompt('b', 'run-2')]);

    expect(after).toEqual({
      summary: 'summary',
      segments: [user('p0', 'earlier'), user('run-1:a', ''), user('run-2:b', '')],
    });
    expect(before.segments).toHaveLength(1);
    expect(after.segments[0]).toBe(before.segments[0]);
  });

  test('a repeated id opens another segment (ids should be unique)', () => {
    const fold = SegmentedFold.of('notes', { data: S.String }).open(UserPrompt, ({ payload }) => ({
      id: 'same',
      data: payload.text,
    }));

    expect(fold.applyAll(fold.initialState(), [prompt('a'), prompt('b')]).segments).toEqual([
      { id: 'same', data: 'a' },
      { id: 'same', data: 'b' },
    ]);
  });

  test('the segment must have a string id and data of the data schema type', () => {
    const fold = SegmentedFold.of('notes', { data: Entry, tag: 'kind' });

    void (() =>
      fold.open(UserPrompt, ({ payload }) => ({
        id: 'x',
        // @ts-expect-error - 'answer' is not a kind of Entry
        data: { kind: 'answer', text: payload.text },
      })));
    void (() =>
      fold.open(ModelStep, ({ payload }) => ({
        id: payload.stepId,
        // @ts-expect-error - a step needs its results
        data: { kind: 'step', text: payload.text },
      })));
    void (() =>
      fold.open(UserPrompt, ({ payload }) => ({
        // @ts-expect-error - the id is a string
        id: 1,
        data: { kind: 'user', text: payload.text },
      })));
    expect(fold.eventNames).toEqual([]);
  });
});

describe('SegmentedFold#attach', () => {
  /** A state without a summary: the folds here have no summary schema. */
  const opened = (): SegmentedState<Entry> => ({
    segments: [user('p1', 'list files'), stepSegment('s1', 'calling ls')],
  });

  test('updates the newest segment `to` names, in place; update gets the narrowed data', () => {
    const fold = SegmentedFold.of('conversation', { data: Entry, tag: 'kind' }).attach(ToolResult, {
      kind: 'step',
      to: (envelope) => {
        expectTypeOf(envelope).toEqualTypeOf<EventEnvelope<typeof ToolResult>>();
        return envelope.payload.stepId;
      },
      update: (data, envelope) => {
        expectTypeOf(data).toEqualTypeOf<Step>();
        expectTypeOf(envelope).toEqualTypeOf<EventEnvelope<typeof ToolResult>>();
        const { callId, output } = envelope.payload;
        return { ...data, results: [...data.results, { callId, output }] };
      },
    });
    const before = opened();

    const after = fold.apply(before, toolResult('s1', 'c1', 'a.ts'));

    expect(after.segments).toEqual([
      user('p1', 'list files'),
      stepSegment('s1', 'calling ls', [{ callId: 'c1', output: 'a.ts' }]),
    ]);
    expect(after.segments[0]).toBe(before.segments[0]);
    expect(before.segments[1]).toEqual(stepSegment('s1', 'calling ls'));
  });

  test('attaches to the newest segment when an id was opened twice', () => {
    const fold = SegmentedFold.of('conversation', { data: Entry, tag: 'kind' }).attach(ToolResult, {
      to: ({ payload }) => payload.stepId,
      update: (_data, { payload }) => ({ kind: 'user', text: payload.output }),
    });
    const state: SegmentedState<Entry> = { segments: [...opened().segments, user('s1', 'again')] };

    expect(fold.apply(state, toolResult('s1', 'c1', 'updated')).segments).toEqual([
      user('p1', 'list files'),
      stepSegment('s1', 'calling ls'),
      user('s1', 'updated'),
    ]);
  });

  test('with kind, a segment of another kind with that id is skipped: kind is part of the address', () => {
    const fold = SegmentedFold.of('conversation', { data: Entry, tag: 'kind' }).attach(ToolResult, {
      kind: 'step',
      to: ({ payload }) => payload.stepId,
      update: (data) => ({ ...data, text: 'attached' }),
    });
    // The newest "s1" is a prompt: the step before it is the target.
    const both: SegmentedState<Entry> = {
      segments: [stepSegment('s1', 'step'), user('s1', 'prompt')],
    };
    // Only a prompt has the id: there is no target.
    const promptOnly: SegmentedState<Entry> = { segments: [user('s1', 'prompt')] };

    expect(fold.apply(both, toolResult('s1', 'c1', 'x')).segments).toEqual([
      stepSegment('s1', 'attached'),
      user('s1', 'prompt'),
    ]);
    expect(fold.apply(promptOnly, toolResult('s1', 'c1', 'x'))).toBe(promptOnly);
  });

  test("onMissing: 'ignore': without a target the state is returned as it was, update not called", () => {
    let calls = 0;
    const fold = SegmentedFold.of('conversation', { data: Entry, tag: 'kind' }).attach(ToolResult, {
      kind: 'step',
      to: ({ payload }) => payload.stepId,
      onMissing: 'ignore',
      update: (data) => {
        calls++;
        return data;
      },
    });
    const state = opened();

    // E.g. a late tool result of a step that a compaction summarized away.
    expect(fold.apply(state, toolResult('compacted-away', 'c1', 'late'))).toBe(state);
    expect(calls).toBe(0);
  });

  test('returns the same state when update returns the same data', () => {
    const fold = SegmentedFold.of('conversation', { data: Entry, tag: 'kind' }).attach(ToolResult, {
      to: ({ payload }) => payload.stepId,
      update: (data) => data,
    });
    const state = opened();

    expect(fold.apply(state, toolResult('s1', 'c1', 'x'))).toBe(state);
  });

  test("the tag defaults to '_tag': kind narrows Effect tagged structs without a tag option", () => {
    const Note = S.Union(
      S.TaggedStruct('note', { text: S.String }),
      S.TaggedStruct('todo', { text: S.String, done: S.Boolean }),
    );
    const Done = AgentNetworkEvent.of('done', S.Struct({ id: S.String }));
    const fold = SegmentedFold.of('notes', { data: Note })
      .open(UserPrompt, ({ payload }) => ({
        id: payload.text,
        data: { _tag: 'todo', text: payload.text, done: false },
      }))
      .attach(Done, {
        kind: 'todo',
        to: ({ payload }) => payload.id,
        update: (todo) => {
          expectTypeOf(todo).toEqualTypeOf<Extract<typeof Note.Type, { _tag: 'todo' }>>();
          return { ...todo, done: true };
        },
      });
    const state = fold.applyAll(
      { segments: [{ id: 'buy milk', data: { _tag: 'note', text: 'a note' } }] },
      [prompt('buy milk'), Done.makeBound(meta, { id: 'buy milk' })],
    );

    expect(state.segments).toEqual([
      { id: 'buy milk', data: { _tag: 'note', text: 'a note' } },
      { id: 'buy milk', data: { _tag: 'todo', text: 'buy milk', done: true } },
    ]);
  });

  test("onMissing is optional and 'report' by default; 'throw' is not an option", () => {
    const fold = SegmentedFold.of('conversation', { data: Entry, tag: 'kind' });
    const to = ({ payload }: EventEnvelope<typeof ToolResult>) => payload.stepId;
    const byDefault = fold.attach(ToolResult, {
      kind: 'step',
      to,
      update: (step) => ({ ...step, text: 'attached' }),
    });
    const state = opened();
    const late = toolResult('compacted-away', 'c1', 'late');
    const skips: FoldSkip[] = [];

    expect(foldStoredEvents(byDefault, state, [late], (skip) => skips.push(skip))).toBe(state);
    expect(skips).toEqual([
      {
        fold: 'conversation',
        reason: 'missing-segment',
        event: late,
        segment: { id: 'compacted-away', kind: 'step' },
      },
    ]);
    expect(byDefault.apply(state, toolResult('s1', 'c1', 'x')).segments[1]).toEqual(
      stepSegment('s1', 'attached'),
    );
    const error = definitionError(() =>
      // @ts-expect-error - a throwing fold could never fold past the event: not an option
      fold.attach(ToolResult, { to, onMissing: 'throw', update: (data) => data }),
    );
    expect(error.message).toBe(
      `SegmentedFold "conversation": .attach() for "tool-result": onMissing must be 'report' ` +
        `(the default: leave the state as it was and report the event) or 'ignore' (leave the ` +
        `state as it was, silently); got "throw".`,
    );
    expectTypeOf<
      SegmentAttachOptions<typeof ToolResult, Entry, 'kind', never>['onMissing']
    >().toEqualTypeOf<'report' | 'ignore' | undefined>();
  });

  test("onMissing: 'report' reports the id it looked for (and the kind, when given)", () => {
    const fold = SegmentedFold.of('conversation', { data: Entry, tag: 'kind' }).attach(ToolResult, {
      to: ({ payload }) => payload.stepId,
      onMissing: 'report',
      update: (data) => data,
    });
    const late = toolResult('gone', 'c1', 'late');
    const skips: FoldSkip[] = [];

    foldStoredEvents(fold, opened(), [late], (skip) => skips.push(skip));

    expect(skips).toEqual([
      { fold: 'conversation', reason: 'missing-segment', event: late, segment: { id: 'gone' } },
    ]);
  });

  test("onMissing: 'ignore' leaves the state as it was without reporting; apply() never reports", () => {
    const ignoring = SegmentedFold.of('conversation', { data: Entry, tag: 'kind' }).attach(
      ToolResult,
      { to: ({ payload }) => payload.stepId, onMissing: 'ignore', update: (data) => data },
    );
    const reporting = conversation();
    const state = opened();
    const late = toolResult('gone', 'c1', 'late');
    const skips: FoldSkip[] = [];

    expect(foldStoredEvents(ignoring, state, [late], (skip) => skips.push(skip))).toBe(state);
    expect(skips).toEqual([]);
    // Folding decoded envelopes directly has no read to report to.
    expect(reporting.applyAll(state, [late])).toBe(state);
  });

  test('a tag field with several literals in one variant: kind narrows that field too', () => {
    const Note = S.Struct({ kind: S.Literal('user', 'tool'), text: S.String });
    const Edited = AgentNetworkEvent.of('edited', S.Struct({ id: S.String, text: S.String }));
    const fold = SegmentedFold.of('notes', { data: Note, tag: 'kind' }).attach(Edited, {
      kind: 'user',
      to: ({ payload }) => payload.id,
      update: (note, { payload }) => {
        expectTypeOf(note).toEqualTypeOf<{ readonly kind: 'user'; readonly text: string }>();
        return { ...note, text: payload.text };
      },
    });
    const state: SegmentedState<typeof Note.Type> = {
      segments: [
        { id: 'n', data: { kind: 'user', text: 'a' } },
        { id: 'n', data: { kind: 'tool', text: 'b' } },
      ],
    };

    // The newest "n" is a tool note: the user note before it is the target.
    expect(fold.apply(state, Edited.makeBound(meta, { id: 'n', text: 'edited' })).segments).toEqual(
      [
        { id: 'n', data: { kind: 'user', text: 'edited' } },
        { id: 'n', data: { kind: 'tool', text: 'b' } },
      ],
    );
  });

  test('rejects options that are not an object with to and update functions and a string kind', () => {
    const fold = SegmentedFold.of('conversation', { data: Entry, tag: 'kind' });
    const message =
      'SegmentedFold "conversation": .attach() needs an event definition ' +
      '(AgentNetworkEvent.of(...)) and options { kind?, to, onMissing, update } with functions ' +
      'to and update and a string kind.';
    const to = () => 's1';
    const update = (data: Entry) => data;

    for (const options of [
      undefined,
      { onMissing: 'ignore', update },
      { to, onMissing: 'ignore', update: 'replace' },
      { kind: 1, to, onMissing: 'ignore', update },
    ]) {
      expect(definitionError(() => fold.attach(ToolResult, options as never)).message).toBe(
        message,
      );
    }
    expect(
      definitionError(() => fold.attach({} as never, { to, onMissing: 'ignore', update } as never))
        .message,
    ).toBe(message);
  });
});

describe('SegmentedFold#on', () => {
  test('on() is the escape hatch: it gets the segmented state; the fold stays segmented', () => {
    const fold = conversation()
      .on(Retracted, (state, envelope) => {
        expectTypeOf(state).toEqualTypeOf<State>();
        expectTypeOf(envelope).toEqualTypeOf<EventEnvelope<typeof Retracted>>();
        return {
          ...state,
          segments: state.segments.filter((segment) => segment.id !== envelope.payload.id),
        };
      })
      .open(AgentNetworkEvent.of('note', S.Struct({ text: S.String })), ({ payload }) => ({
        id: 'note',
        data: { kind: 'user', text: payload.text },
      }));

    const state = fold.applyAll(fold.initialState(), [
      prompt('one'),
      step('s1', 'calling ls'),
      Retracted.makeBound(meta, { id: 's1' }),
    ]);

    expect(state.segments).toEqual([user('prompt:run-1', 'one')]);
    expect(fold.eventNames).toContain('note');
  });

  test('one handler per event across open, attach and on (also a type error)', () => {
    const fold = conversation();
    const message = (method: string, event: string, existing: string) =>
      `SegmentedFold "conversation": ${method} for "${event}", which already has a handler ` +
      `(${existing}); a fold handles each event once.`;

    const attachOpened = definitionError(() =>
      // @ts-expect-error - UserPrompt already opens a segment
      fold.attach(UserPrompt, { to: () => 'x', onMissing: 'ignore', update: (data) => data }),
    );
    const openAttached = definitionError(() =>
      // @ts-expect-error - ToolResult already attaches
      fold.open(ToolResult, ({ payload }) => ({ id: payload.stepId, data: user('', '').data })),
    );
    const onOpened = definitionError(() =>
      // @ts-expect-error - ModelStep already opens a segment
      fold.on(ModelStep, (state) => state),
    );

    expect(attachOpened.message).toBe(message('.attach()', 'user-prompt', '.open()'));
    expect(openAttached.message).toBe(message('.open()', 'tool-result', '.attach()'));
    expect(onOpened.message).toBe(message('.on()', 'model-step', '.open()'));
  });

  test('open() rejects an event that is not an event definition or a segment that is not a function', () => {
    const fold = SegmentedFold.of('notes', { data: S.String });
    const message =
      'SegmentedFold "notes": .open() needs an event definition (AgentNetworkEvent.of(...)) and ' +
      'a function.';

    expect(definitionError(() => fold.open(UserPrompt, 'x' as never)).message).toBe(message);
    expect(
      definitionError(() => fold.open(null as never, () => ({ id: '', data: '' }))).message,
    ).toBe(message);
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
        user('prompt:run-1', 'list files'),
        stepSegment('s1', 'calling ls and cat', [
          { callId: 'c1', output: 'a.ts b.ts' },
          { callId: 'c2', output: 'export {}' },
        ]),
      ],
    });
  });

  test('later events fold on top of a compacted state; a late result of a summarized step is ignored', () => {
    const fold = conversation();
    const kept = user('prompt:run-2', 'second');
    // What a compaction leaves: a summary of the older segments, and the newest one kept.
    const compacted: State = { summary: 'asked first, got a long step', segments: [kept] };

    const state = fold.applyAll(compacted, [
      step('s2', 'answering second'),
      toolResult('s1', 'c1', 'late result of a summarized step'),
    ]);

    expect(state).toEqual({
      summary: 'asked first, got a long step',
      segments: [kept, stepSegment('s2', 'answering second')],
    });
  });
});

describe('types', () => {
  test('the type parameters: name, scope, data, summary, tag and handled events', () => {
    expectTypeOf(conversation()).toEqualTypeOf<
      SegmentedFold<
        'conversation',
        'context',
        Entry,
        string,
        'kind',
        'user-prompt' | 'model-step' | 'tool-result'
      >
    >();
    expectTypeOf(SegmentedFold.of('notes', { data: S.String })).toEqualTypeOf<
      SegmentedFold<'notes', 'context', string, never, '_tag'>
    >();
    expectTypeOf(conversation()).toExtend<
      ContextFoldBase<
        'conversation',
        'context',
        State,
        'user-prompt' | 'model-step' | 'tool-result'
      >
    >();
  });

  test('per-variant narrowing: a variant whose tag has several literals keeps only the kind', () => {
    const Mixed = S.Union(
      S.Struct({ kind: S.Literal('user', 'tool'), text: S.String }),
      S.Struct({ kind: S.Literal('step'), results: S.Array(S.String) }),
    );
    type Mixed = typeof Mixed.Type;
    const fold = SegmentedFold.of('mixed', { data: Mixed, tag: 'kind' });

    expectTypeOf<SegmentKindOf<Mixed, 'kind'>>().toEqualTypeOf<'user' | 'tool' | 'step'>();
    expectTypeOf<SegmentDataOfKind<Mixed, 'kind', 'tool'>>().toEqualTypeOf<{
      readonly kind: 'tool';
      readonly text: string;
    }>();
    expectTypeOf<SegmentDataOfKind<Mixed, 'kind', 'step'>>().toEqualTypeOf<
      Extract<Mixed, { kind: 'step' }>
    >();
    void (() =>
      fold.attach(ToolResult, {
        kind: 'user',
        to: () => 'n',
        // @ts-expect-error - kind 'user' stays a user: update cannot turn it into a tool
        update: (data) => ({ ...data, kind: 'tool' }),
      }));
    expect(fold.eventNames).toEqual([]);
  });

  test('kind narrows the data of update, which must return that variant', () => {
    const fold = SegmentedFold.of('conversation', { data: Entry, tag: 'kind' });
    const to = () => 's1';

    void (() =>
      fold.attach(ToolResult, {
        kind: 'step',
        to,
        // @ts-expect-error - kind 'step' updates a step: a prompt is another variant
        update: (data) => ({ kind: 'user', text: data.text }),
      }));
    void (() =>
      fold.attach(ToolResult, {
        kind: 'user',
        to,
        // @ts-expect-error - a prompt has no results
        update: (data) => ({ ...data, results: data.results }),
      }));
    void (() =>
      fold.attach(ToolResult, {
        // @ts-expect-error - 'tool' is not a kind of Entry
        kind: 'tool',
        to,
        update: (data) => data,
      }));
    void (() =>
      fold.attach(ToolResult, {
        to,
        update: (data) => {
          expectTypeOf(data).toEqualTypeOf<Entry>();
          return data;
        },
      }));
    expect(fold.eventNames).toEqual([]);
  });

  test("kind needs a valid tag: without tag: 'kind', kind is a KindNeedsSegmentTag error", () => {
    const fold = SegmentedFold.of('conversation', { data: Entry });

    void (() =>
      fold.attach(ToolResult, {
        // @ts-expect-error - Entry is not tagged by '_tag': set tag: 'kind' on SegmentedFold.of()
        kind: 'step',
        to: () => 's1',
        update: (data) => data,
      }));
    expectTypeOf<
      SegmentAttachOptions<typeof ToolResult, Entry, '_tag', never>['kind']
    >().toEqualTypeOf<KindNeedsSegmentTag<'_tag'> | undefined>();
    expectTypeOf<
      SegmentAttachOptions<typeof ToolResult, Entry, 'kind', 'step'>['kind']
    >().toEqualTypeOf<'step' | undefined>();
    expect(fold.name).toBe('conversation');
  });

  test('the tag must be a field with a string literal type in every variant of the data', () => {
    // @ts-expect-error - text is a string, not a literal: it does not tell the variants apart
    void (() => SegmentedFold.of('c', { data: Entry, tag: 'text' }));
    // @ts-expect-error - results is not in every variant
    void (() => SegmentedFold.of('c', { data: Entry, tag: 'results' }));
    // @ts-expect-error - a string data has no fields
    void (() => SegmentedFold.of('c', { data: S.String, tag: 'kind' }));

    expectTypeOf<SegmentTagOf<Entry>>().toEqualTypeOf<'kind'>();
    expectTypeOf<SegmentTagOf<string>>().toEqualTypeOf<never>();
    expectTypeOf<SegmentKindOf<Entry, 'kind'>>().toEqualTypeOf<'user' | 'step'>();
    expectTypeOf<SegmentKindOf<Entry, '_tag'>>().toEqualTypeOf<never>();
    expectTypeOf<SegmentDataOfKind<Entry, 'kind', 'step'>>().toEqualTypeOf<Step>();
    expectTypeOf<SegmentDataOfKind<Entry, 'kind', never>>().toEqualTypeOf<Entry>();
    expectTypeOf<ValidSegmentTag<Entry, 'kind'>>().toEqualTypeOf<unknown>();
    expectTypeOf<ValidSegmentTag<Entry, 'text'>>().toEqualTypeOf<InvalidSegmentTag<'text'>>();
  });

  test('a duplicate handler is a type error naming the event', () => {
    const fold = conversation();

    expectTypeOf<Parameters<typeof fold.open<typeof UserPrompt>>[0]>().toEqualTypeOf<
      typeof UserPrompt & DuplicateFoldHandler<'user-prompt'>
    >();
    expectTypeOf<Parameters<typeof fold.attach<typeof Retracted>>[0]>().toEqualTypeOf<
      typeof Retracted
    >();
  });

  test('state helpers: SegmentOf, SegmentDataOf, SummaryOf', () => {
    expectTypeOf<SegmentOf<State>>().toEqualTypeOf<Segment<Entry>>();
    expectTypeOf<SegmentDataOf<State>>().toEqualTypeOf<Entry>();
    expectTypeOf<SummaryOf<State>>().toEqualTypeOf<string>();
  });
});

describe('exports', () => {
  test('SegmentedFold and its types are exported by name from both entry points', () => {
    for (const entry of [root, matrix]) {
      expect(entry.SegmentedFold).toBe(SegmentedFold);
      expect(entry).not.toHaveProperty('SegmentedFoldImpl');
      expect(entry).not.toHaveProperty('isSegmentedFold');
    }
    expect('checkpointOn' in conversation()).toBe(false);
    // @ts-expect-error - removed: compaction is ctx.folds.<name>.compact()
    void (() => conversation().checkpointOn);
    expectTypeOf<Root.AnySegmentedFold<Entry, 'kind'>>().toEqualTypeOf<
      AnySegmentedFold<Entry, 'kind'>
    >();
    expectTypeOf<Matrix.AnySegmentedFold>().toEqualTypeOf<AnySegmentedFold>();
    type Fold = SegmentedFold<'a', 'run', Entry, string, 'kind'>;
    type Options = SegmentedFoldOptions<typeof Entry, typeof S.String, 'kind', 'run'>;
    type Attach = SegmentAttachOptions<typeof ToolResult, Entry, 'kind', 'step'>;
    expectTypeOf<Root.SegmentedFold<'a', 'run', Entry, string, 'kind'>>().toEqualTypeOf<Fold>();
    expectTypeOf<Matrix.SegmentedFold<'a', 'run', Entry, string, 'kind'>>().toEqualTypeOf<Fold>();
    expectTypeOf<
      Root.SegmentedFoldOptions<typeof Entry, typeof S.String, 'kind', 'run'>
    >().toEqualTypeOf<Options>();
    expectTypeOf<
      Matrix.SegmentedFoldOptions<typeof Entry, typeof S.String, 'kind', 'run'>
    >().toEqualTypeOf<Options>();
    expectTypeOf<
      Root.SegmentAttachOptions<typeof ToolResult, Entry, 'kind', 'step'>
    >().toEqualTypeOf<Attach>();
    expectTypeOf<
      Matrix.SegmentAttachOptions<typeof ToolResult, Entry, 'kind', 'step'>
    >().toEqualTypeOf<Attach>();
    expectTypeOf<Root.SegmentTagOf<Entry>>().toEqualTypeOf<'kind'>();
    expectTypeOf<Matrix.SegmentKindOf<Entry, 'kind'>>().toEqualTypeOf<'user' | 'step'>();
    expectTypeOf<Root.SegmentDataOfKind<Entry, 'kind', 'step'>>().toEqualTypeOf<Step>();
    expectTypeOf<Matrix.ValidSegmentTag<Entry, 'x'>>().toEqualTypeOf<InvalidSegmentTag<'x'>>();
    expectTypeOf<Root.InvalidSegmentTag<'x'>>().toEqualTypeOf<InvalidSegmentTag<'x'>>();
    expectTypeOf<Root.KindNeedsSegmentTag<'x'>>().toEqualTypeOf<KindNeedsSegmentTag<'x'>>();
    expectTypeOf<Matrix.KindNeedsSegmentTag<'x'>>().toEqualTypeOf<KindNeedsSegmentTag<'x'>>();
    expectTypeOf<Root.Segment<number>>().toEqualTypeOf<Segment<number>>();
    expectTypeOf<Matrix.Segment<number>>().toEqualTypeOf<Segment<number>>();
    expectTypeOf<Root.SegmentedState<number, string>>().toEqualTypeOf<
      SegmentedState<number, string>
    >();
    expectTypeOf<Matrix.AnySegmentedState>().toEqualTypeOf<AnySegmentedState>();
    expectTypeOf<Root.AnySegmentedState>().toEqualTypeOf<AnySegmentedState>();
    expectTypeOf<Root.SegmentOf<State>>().toEqualTypeOf<SegmentOf<State>>();
    expectTypeOf<Matrix.SegmentDataOf<State>>().toEqualTypeOf<SegmentDataOf<State>>();
    expectTypeOf<Root.SummaryOf<State>>().toEqualTypeOf<SummaryOf<State>>();
  });

  test('the builder stages and the static open / attach helpers are gone', () => {
    expect('open' in SegmentedFold).toBe(false);
    expect('attach' in SegmentedFold).toBe(false);
    // @ts-expect-error - removed: SegmentedFold.of() takes the data schema and returns a fold
    expectTypeOf<Root.SegmentedFoldBuilder>().toBeAny();
    // @ts-expect-error - removed: there is no over() stage
    expectTypeOf<Matrix.SegmentedFoldEventsBuilder>().toBeAny();
  });
});
