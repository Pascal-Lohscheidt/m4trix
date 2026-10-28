import { Option } from 'effect';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
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
  type ContextFoldBuilder,
  ContextFoldDefinitionError,
  type ContextFoldOptions,
  type DeepReadonly,
  type DuplicateFoldHandler,
  type FoldReadStateOf,
  type FoldScope,
  type FoldSkip,
  type FoldStateOf,
  foldEventDefinitions,
  foldStoredEvents,
  type InvalidFoldName,
  type UnhandledFoldEvent,
  type ValidFoldName,
} from './context-fold.js';
import type { FoldCheckpointEventName } from './fold-checkpoint.js';
import { SegmentedFold, type SegmentedState } from './segmented-fold.js';
import { ContextView } from './view.js';

/* ─── Fixtures ─── */

const UserPrompt = AgentNetworkEvent.of('user-prompt', S.Struct({ text: S.String }));
const ModelStep = AgentNetworkEvent.of(
  'model-step',
  S.Struct({ stepId: S.String, text: S.String }),
);
const ToolResult = AgentNetworkEvent.of(
  'tool-result',
  S.Struct({ stepId: S.String, output: S.String }),
);

type Turn = { readonly role: 'user' | 'assistant' | 'tool' | 'summary'; readonly text: string };
type ConversationState = { readonly turns: readonly Turn[] };

const meta = { runId: 'run-1', contextId: 'ctx-1' };
const prompt = (text: string) => UserPrompt.makeBound(meta, { text });
const step = (stepId: string, text: string) => ModelStep.makeBound(meta, { stepId, text });
const toolResult = (stepId: string, output: string) =>
  ToolResult.makeBound(meta, { stepId, output });

/** A fold over every fixture event, without a state schema. */
const conversation = () =>
  ContextFold.of('conversation')
    .initial((): ConversationState => ({ turns: [] }))
    .on(UserPrompt, (state, envelope) => {
      expectTypeOf(state).toEqualTypeOf<ConversationState>();
      expectTypeOf(envelope).toEqualTypeOf<EventEnvelope<typeof UserPrompt>>();
      expectTypeOf(envelope.payload).toEqualTypeOf<typeof UserPrompt.payload.Type>();
      return { turns: [...state.turns, { role: 'user', text: envelope.payload.text }] };
    })
    .on(ModelStep, (state, { name, payload }) => {
      expectTypeOf(name).toEqualTypeOf<'model-step'>();
      expectTypeOf(payload).toEqualTypeOf<{ readonly stepId: string; readonly text: string }>();
      return { turns: [...state.turns, { role: 'assistant', text: payload.text }] };
    })
    .on(ToolResult, (state, { payload }) => ({
      turns: [...state.turns, { role: 'tool', text: `${payload.stepId}: ${payload.output}` }],
    }));

const ConversationSchema = S.Struct({
  turns: S.Array(
    S.Struct({ role: S.Literal('user', 'assistant', 'tool', 'summary'), text: S.String }),
  ),
});
type CompactableState = typeof ConversationSchema.Type;

/** The conversation with a `state` schema: it can compact (the runtime publishes checkpoints). */
const compactable = (options: { readonly version?: number } = {}) =>
  ContextFold.of('conversation', { state: ConversationSchema, ...options })
    .initial(() => ({ turns: [] }))
    .on(UserPrompt, (state, { payload }) => ({
      turns: [...state.turns, { role: 'user', text: payload.text }],
    }))
    .on(ModelStep, (state, { payload }) => ({
      turns: [...state.turns, { role: 'assistant', text: payload.text }],
    }));

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

describe('ContextFold builder', () => {
  test('of(name).initial().on(): the handlers define the events; no over() stage', () => {
    const fold = conversation();

    expect(fold.name).toBe('conversation');
    expect(fold.version).toBe(1);
    expect(fold.scope).toBe('context');
    expect(fold.eventNames).toEqual(['user-prompt', 'model-step', 'tool-result']);
    expect(fold.checkpointEventName).toBeUndefined();
    expect(fold.stateSchema).toBeUndefined();

    expectTypeOf(fold.name).toEqualTypeOf<'conversation'>();
    expectTypeOf(fold.scope).toEqualTypeOf<'context'>();
    expectTypeOf(fold.eventNames).toEqualTypeOf<
      ReadonlyArray<'user-prompt' | 'model-step' | 'tool-result'>
    >();
    const builder = ContextFold.of('conversation');
    expect('over' in builder).toBe(false);
    expect('scope' in builder).toBe(false);
    // @ts-expect-error - there is no over(): the handlers define the events
    void (() => builder.over([UserPrompt]));
    // @ts-expect-error - the scope is an option of of(), not a method
    void (() => builder.scope('run'));
  });

  test('eventNames lists the handled events, in the order added', () => {
    const fold = ContextFold.of('count')
      .initial(() => 0)
      .on(ModelStep, (count) => count + 1)
      .on(UserPrompt, (count) => count + 1);

    expect(fold.eventNames).toEqual(['model-step', 'user-prompt']);
    expectTypeOf(fold.eventNames).toEqualTypeOf<ReadonlyArray<'model-step' | 'user-prompt'>>();
  });

  test('the options are optional: version defaults to 1, scope to context', () => {
    const build = <Scope extends FoldScope>(builder: ContextFoldBuilder<'conversation', Scope>) =>
      builder.initial(() => 0).on(UserPrompt, (count) => count + 1);

    for (const fold of [
      build(ContextFold.of('conversation')),
      build(ContextFold.of('conversation', {})),
      build(ContextFold.of('conversation', { version: undefined, scope: undefined })),
    ]) {
      expect([fold.version, fold.scope]).toEqual([1, 'context']);
    }
    expect(build(ContextFold.of('conversation', { version: 3 })).version).toBe(3);

    expectTypeOf(ContextFold.of('conversation')).toEqualTypeOf<
      ContextFoldBuilder<'conversation'>
    >();
    expectTypeOf<ContextFoldOptions>().toEqualTypeOf<{
      readonly scope?: FoldScope;
      readonly version?: number;
      readonly state?: S.Schema.AnyNoContext;
    }>();
    // @ts-expect-error - the version is a number
    expect(() => ContextFold.of('conversation', { version: '2' })).toThrow(
      ContextFoldDefinitionError,
    );
  });

  test('the scope is an option: run folds the current run only', () => {
    const run = ContextFold.of('steps', { scope: 'run' })
      .initial(() => 0)
      .on(ModelStep, (count) => count + 1);
    const context = ContextFold.of('steps', { scope: 'context', version: 2 })
      .initial(() => 0)
      .on(ModelStep, (count) => count + 1);

    expect(run.scope).toBe('run');
    expect(context.scope).toBe('context');
    expectTypeOf(run.scope).toEqualTypeOf<'run'>();
    expectTypeOf(context.scope).toEqualTypeOf<'context'>();
    expectTypeOf(ContextFold.of('steps', { scope: 'run' })).toEqualTypeOf<
      ContextFoldBuilder<'steps', 'run'>
    >();
  });

  test('builders and folds are immutable: every step returns a new object', () => {
    const builder = ContextFold.of('conversation');
    const base = builder.initial(() => 0);
    const counted = base.on(UserPrompt, (count) => count + 1);
    const steppedToo = counted.on(ModelStep, (count) => count + 1);

    expect(new Set([builder, base, counted, steppedToo]).size).toBe(4);
    expect(base.eventNames).toEqual([]);
    expect(counted.eventNames).toEqual(['user-prompt']);
    expect(steppedToo.eventNames).toEqual(['user-prompt', 'model-step']);
  });

  test('branches of one fold are independent: each step copies the handlers', () => {
    const base = ContextFold.of('count')
      .initial(() => 0)
      .on(UserPrompt, (count) => count + 1);
    const byTen = base.on(ModelStep, (count) => count + 10);
    const byHundred = base.on(ModelStep, (count) => count + 100);
    const events = [prompt('a'), step('s1', 'b')];

    expect(byTen.applyAll(0, events)).toBe(11);
    expect(byHundred.applyAll(0, events)).toBe(101);
    expect(base.applyAll(0, events)).toBe(1);
    expect(base.eventNames).toEqual(['user-prompt']);
  });

  test('initialState() calls initial() on every cold start (a fresh state each time)', () => {
    const fold = conversation();

    const first = fold.initialState();
    const second = fold.initialState();

    expect(first).toEqual({ turns: [] });
    expect(second).not.toBe(first);
    expectTypeOf(first).toEqualTypeOf<ConversationState>();
  });
});

describe('ContextFold state schema', () => {
  const TurnSchema = S.Struct({ role: S.Literal('user', 'assistant'), text: S.String });
  const Transcript = S.Struct({ turns: S.Array(TurnSchema), open: S.Boolean });
  type Transcript = typeof Transcript.Type;

  test('without a schema, the state is what initial() returns: [] infers never[]', () => {
    const fold = ContextFold.of('transcript')
      .initial(() => ({ turns: [] }))
      .on(UserPrompt, (state) => state);

    // The pitfall a state schema fixes: nothing can ever be added to these turns.
    expectTypeOf<FoldStateOf<typeof fold>>().toEqualTypeOf<{ turns: never[] }>();
    expect(fold.stateSchema).toBeUndefined();
    expectTypeOf(fold.stateSchema).toEqualTypeOf<undefined>();
  });

  test('with a state schema, the state type is the schema type: initial() needs no annotation', () => {
    const fold = ContextFold.of('transcript', { state: Transcript })
      .initial(() => ({ turns: [], open: true }))
      .on(UserPrompt, (state, { payload }) => {
        expectTypeOf(state).toEqualTypeOf<Transcript>();
        return { ...state, turns: [...state.turns, { role: 'user', text: payload.text }] };
      });

    expect(fold.stateSchema).toBe(Transcript);
    expect(fold.applyAll(fold.initialState(), [prompt('hi')])).toEqual({
      turns: [{ role: 'user', text: 'hi' }],
      open: true,
    });
    expectTypeOf<FoldStateOf<typeof fold>>().toEqualTypeOf<Transcript>();
    expectTypeOf(ContextFold.of('transcript', { state: Transcript })).toEqualTypeOf<
      ContextFoldBuilder<'transcript', 'context', S.Schema<Transcript, typeof Transcript.Encoded>>
    >();
    expectTypeOf(fold.stateSchema).toEqualTypeOf<S.Schema<Transcript, typeof Transcript.Encoded>>();
  });

  test('the fold type keeps the schema, linked to the state and its encoded type, at every step', () => {
    const Counter = S.Struct({ count: S.NumberFromString });
    type Counter = { readonly count: number };
    const fold = ContextFold.of('counter', { state: Counter })
      .initial(() => ({ count: 0 }))
      .on(UserPrompt, (state) => ({ count: state.count + 1 }));

    expect(
      S.encodeSync(fold.stateSchema)(fold.applyAll(fold.initialState(), [prompt('a')])),
    ).toEqual({
      count: '1',
    });
    expectTypeOf(fold.stateSchema).toEqualTypeOf<S.Schema<Counter, { readonly count: string }>>();
    expectTypeOf(fold).toEqualTypeOf<
      ContextFold<
        'counter',
        'context',
        Counter,
        'user-prompt',
        S.Schema<Counter, { readonly count: string }>
      >
    >();
  });

  test('initial() and handlers are checked against the schema type', () => {
    const builder = ContextFold.of('transcript', { state: Transcript, scope: 'run' });
    const fold = builder.initial(() => ({ turns: [], open: false }));

    // @ts-expect-error - open is a boolean
    void (() => builder.initial(() => ({ turns: [], open: 'yes' })));
    // @ts-expect-error - a turn's role is 'user' or 'assistant'
    void (() => builder.initial(() => ({ turns: [{ role: 'tool', text: '' }], open: true })));
    void (() =>
      // @ts-expect-error - a handler returns the schema type
      fold.on(UserPrompt, (state) => ({ ...state, open: 1 })));
    expect(fold.scope).toBe('run');
  });

  test('rejects a state that is not an Effect schema', () => {
    const error = definitionError(() =>
      // @ts-expect-error - the state is described by an Effect schema
      ContextFold.of('transcript', { state: { turns: [] } }),
    );

    expect(error.foldName).toBe('transcript');
    expect(error.message).toBe(
      'ContextFold "transcript": the state option must be an Effect schema, e.g. ' +
        'S.Struct({ ... }).',
    );
  });
});

describe('ContextFold apply', () => {
  test('apply() runs the handler of the event and returns the next state', () => {
    const fold = conversation();

    const next = fold.apply(fold.initialState(), prompt('hi'));

    expect(next).toEqual({ turns: [{ role: 'user', text: 'hi' }] });
    expectTypeOf(next).toEqualTypeOf<ConversationState>();
  });

  test('apply() leaves the state unchanged (same reference) for events the fold does not handle', () => {
    const fold = conversation();
    const state = fold.initialState();

    expect(fold.apply(state, { name: 'unknown', meta, payload: {} })).toBe(state);
    // Checkpoints too: the reader restores them; handlers never see one.
    const checkpoint = {
      name: 'm4trix:fold.checkpoint:conversation@1',
      meta,
      payload: { fold: 'conversation', version: 1, through: null, state: { turns: [] } },
    };
    expect(compactable().apply(state, checkpoint)).toBe(state);
  });

  test('applyAll() folds the events in order', () => {
    const fold = conversation();

    const state = fold.applyAll(fold.initialState(), [
      prompt('list files'),
      step('s1', 'calling ls'),
      toolResult('s1', 'a.ts b.ts'),
      step('s2', 'two files'),
    ]);

    expect(state.turns).toEqual([
      { role: 'user', text: 'list files' },
      { role: 'assistant', text: 'calling ls' },
      { role: 'tool', text: 's1: a.ts b.ts' },
      { role: 'assistant', text: 'two files' },
    ]);
    expectTypeOf(state).toEqualTypeOf<ConversationState>();
  });

  test('applyAll() checks the fold once, not once per event', () => {
    const fold = conversation();
    const check = vi.spyOn(fold as unknown as { assertEvents(): void }, 'assertEvents');

    fold.applyAll(fold.initialState(), [prompt('a'), prompt('b'), prompt('c')]);

    // initialState() and applyAll(): one check each.
    expect(check).toHaveBeenCalledTimes(2);
  });

  test('applyAll() accepts any iterable and returns the given state for no events', () => {
    const fold = conversation();
    const state = fold.initialState();
    function* events() {
      yield prompt('a');
      yield prompt('b');
    }

    expect(fold.applyAll(state, [])).toBe(state);
    expect(fold.applyAll(state, events()).turns.map((t) => t.text)).toEqual(['a', 'b']);
  });

  test('handlers see the state of the previous event (pure, no shared mutation)', () => {
    const fold = conversation();
    const initial = fold.initialState();

    const one = fold.apply(initial, prompt('one'));
    const two = fold.apply(one, prompt('two'));

    expect(initial.turns).toEqual([]);
    expect(one.turns).toHaveLength(1);
    expect(two.turns).toHaveLength(2);
  });
});

describe('foldStoredEvents: folding events as the store keeps them', () => {
  const Priced = AgentNetworkEvent.of('priced', S.Struct({ cents: S.NumberFromString }));
  const Total = ContextFold.of('total')
    .initial(() => 0)
    .on(Priced, (sum, { payload }) => sum + payload.cents);
  const stored = (cents: unknown) => ({ name: 'priced', meta, payload: { cents } });

  test('decodes each payload with its event schema first; apply() takes decoded envelopes', () => {
    expect(foldStoredEvents(Total, 0, [stored('2'), stored('40')])).toBe(42);
    expect(Total.applyAll(0, [Priced.makeBound(meta, { cents: '2' })])).toBe(2);
  });

  test('passes events the fold does not handle by, like apply()', () => {
    const skips: FoldSkip[] = [];

    expect(foldStoredEvents(Total, 1, [prompt('hi')], (skip) => skips.push(skip))).toBe(1);
    expect(skips).toEqual([]);
  });

  test('leaves out what does not decode and reports it, with or without a reporter', () => {
    const skips: FoldSkip[] = [];
    const bad = stored('two');

    expect(foldStoredEvents(Total, 0, [stored('1'), bad], (skip) => skips.push(skip))).toBe(1);
    expect(foldStoredEvents(Total, 0, [bad, stored('5')])).toBe(5);
    expect(skips).toEqual([
      {
        fold: 'total',
        reason: 'decode',
        event: bad,
        error: expect.objectContaining({ _tag: 'ParseError' }),
      },
    ]);
  });

  test('foldEventDefinitions: the definitions of the handled events, in the order added', () => {
    expect(foldEventDefinitions(conversation())).toEqual([UserPrompt, ModelStep, ToolResult]);
  });
});

describe('ContextFold checkpoints: published by the runtime, named by the fold', () => {
  test('a context-scoped fold with a state schema has a checkpoint event per name and version', () => {
    const fold = compactable();
    const bumped = compactable({ version: 2 });

    expect(fold.checkpointEventName).toBe('m4trix:fold.checkpoint:conversation@1');
    expect(bumped.checkpointEventName).toBe('m4trix:fold.checkpoint:conversation@2');
    // Not one of the fold's own events: the runtime reads it on top of them.
    expect(fold.eventNames).toEqual(['user-prompt', 'model-step']);
    expectTypeOf(fold.checkpointEventName).toEqualTypeOf<FoldCheckpointEventName<'conversation'>>();
    expectTypeOf(
      fold.checkpointEventName,
    ).toExtend<`m4trix:fold.checkpoint:conversation@${number}`>();
  });

  test('a fold without a state schema, or a run-scoped one, has none: it cannot compact', () => {
    const withoutSchema = conversation();
    const runScoped = ContextFold.of('progress', { scope: 'run', state: S.Number })
      .initial(() => 0)
      .on(ModelStep, (steps) => steps + 1);

    expect(withoutSchema.checkpointEventName).toBeUndefined();
    expect(runScoped.checkpointEventName).toBeUndefined();
    expectTypeOf(withoutSchema.checkpointEventName).toEqualTypeOf<undefined>();
    expectTypeOf(runScoped.checkpointEventName).toEqualTypeOf<undefined>();
  });

  test('there is no .checkpointOn(): no user event is a checkpoint any more', () => {
    const fold = compactable();

    expect('checkpointOn' in fold).toBe(false);
    // @ts-expect-error - removed: compact through ctx.folds.<name>.compact()
    void (() => fold.checkpointOn(ModelStep, () => ({ turns: [] })));
    expectTypeOf<FoldStateOf<typeof fold>>().toEqualTypeOf<CompactableState>();
  });
});

describe('ContextFold definition errors', () => {
  test('ContextFoldDefinitionError carries a tag, the fold name and a message', () => {
    const error = new ContextFoldDefinitionError('conversation', 'boom');

    expect(error).toBeInstanceOf(Error);
    expect(error._tag).toBe('ContextFoldDefinitionError');
    expect(error.name).toBe('ContextFoldDefinitionError');
    expect(error.foldName).toBe('conversation');
    expect(error.message).toBe('boom');
    expectTypeOf(error._tag).toEqualTypeOf<'ContextFoldDefinitionError'>();
  });

  test.each([
    '',
    '1st',
    'chat-view',
    'chat view',
    'chät',
    '__proto__',
  ])('rejects %j: the name becomes a ctx.folds property and must be a JS identifier', (name) => {
    const error = definitionError(() => ContextFold.of(name));

    expect(error.foldName).toBe(name);
    expect(error.message).toContain(JSON.stringify(name));
    expect(error.message).toContain('identifier');
  });

  test('rejects invalid literal names at type level; inference of the name is unchanged', () => {
    // @ts-expect-error - a fold name must be a JS identifier (it is a ctx.folds key)
    expect(() => ContextFold.of('chat-view')).toThrow(ContextFoldDefinitionError);
    // @ts-expect-error - a fold name cannot start with a digit
    expect(() => ContextFold.of('1st', { scope: 'run' })).toThrow(ContextFoldDefinitionError);
    // @ts-expect-error - __proto__ would set the prototype of ctx.folds
    expect(() => ContextFold.of('__proto__')).toThrow(ContextFoldDefinitionError);

    const fold = ContextFold.of('chatV2')
      .initial(() => 0)
      .on(UserPrompt, (count) => count + 1);
    expectTypeOf(fold.name).toEqualTypeOf<'chatV2'>();
    expectTypeOf(ContextFold.of('$steps')).toEqualTypeOf<ContextFoldBuilder<'$steps'>>();
    const dynamic: string = 'conversation';
    expectTypeOf(ContextFold.of(dynamic)).toEqualTypeOf<ContextFoldBuilder<string>>();
  });

  test.each([
    'conversation',
    'chatV2',
    '_internal',
    '$steps',
    'a',
  ])('accepts the name %j', (name) => {
    expect(ContextFold.of(name).initial(() => 0).name).toBe(name);
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects version %s: it must be a positive integer', (version) => {
    const error = definitionError(() => ContextFold.of('conversation', { version }));

    expect(error.foldName).toBe('conversation');
    expect(error.message).toBe(
      `ContextFold "conversation": version must be a positive integer; got ${version}.`,
    );
  });

  test('rejects an unknown scope', () => {
    const error = definitionError(() =>
      // @ts-expect-error - only 'context' and 'run' are scopes
      ContextFold.of('conversation', { scope: 'session' }),
    );

    expect(error.message).toBe(
      `ContextFold "conversation": unknown scope "session"; use 'context' or 'run'.`,
    );
  });

  test('rejects a second handler for an event (also a type error)', () => {
    const fold = ContextFold.of('conversation')
      .initial(() => 0)
      .on(UserPrompt, (count) => count + 1);

    const error = definitionError(() =>
      // @ts-expect-error - UserPrompt already has a handler
      fold.on(UserPrompt, (count) => count + 2),
    );

    expect(error.message).toBe(
      'ContextFold "conversation": .on() for "user-prompt", which already has a handler ' +
        '(.on()); a fold handles each event once.',
    );
  });

  test('rejects handlers that are not functions and events that are not event definitions', () => {
    const builder = ContextFold.of('conversation');
    const fold = builder.initial(() => 0);
    const cases: Array<[() => unknown, string]> = [
      [() => builder.initial('zero' as never), '.initial() needs a function () => state.'],
      [
        () => fold.on(UserPrompt, undefined as never),
        '.on() needs an event definition (AgentNetworkEvent.of(...)) and a function.',
      ],
      [
        () => fold.on({ payload: S.String } as never, (count: number) => count),
        '.on() needs an event definition (AgentNetworkEvent.of(...)) and a function.',
      ],
    ];

    for (const [build, detail] of cases) {
      expect(definitionError(build).message).toBe(`ContextFold "conversation": ${detail}`);
    }
  });
});

describe('a fold without events', () => {
  const empty = () => ContextFold.of('empty').initial(() => 0);
  const noEvents = 'ContextFold "empty": it folds no events; add a handler (.on()).';

  test('is rejected by validate(), which .folds([...]) runs when an agent is built', () => {
    const error = definitionError(() => ContextFold.validate(empty()));

    expect(error.foldName).toBe('empty');
    expect(error.message).toBe(noEvents);
  });

  test('throws on first use: initialState(), apply(), applyAll() and ContextView.of()', () => {
    const fold = empty();

    for (const use of [
      () => fold.initialState(),
      () => fold.apply(0, prompt('hi')),
      () => fold.applyAll(0, []),
      () => ContextView.of(fold, { measure: (count) => count }),
    ]) {
      expect(definitionError(use).message).toBe(noEvents);
    }
  });

  test('is still a fold to the types: the check is at runtime', () => {
    expectTypeOf(empty()).toExtend<AnyContextFold>();
    expectTypeOf(empty().eventNames).toEqualTypeOf<ReadonlyArray<never>>();
  });

  test('a state schema does not make it valid: its checkpoints alone are no events', () => {
    const fold = ContextFold.of('empty', { state: S.Number }).initial(() => 0);

    expect(fold.checkpointEventName).toBe('m4trix:fold.checkpoint:empty@1');
    expect(definitionError(() => ContextFold.validate(fold)).message).toBe(noEvents);
  });
});

describe('ContextFold.validate', () => {
  test('accepts a fold and asserts the AnyContextFold type', () => {
    const source: unknown = conversation();

    ContextFold.validate(source);

    expectTypeOf(source).toEqualTypeOf<AnyContextFold>();
    expect(source.name).toBe('conversation');
    expect(() =>
      ContextFold.validate(
        SegmentedFold.of('s', { data: S.String }).open(UserPrompt, ({ payload }) => ({
          id: payload.text,
          data: payload.text,
        })),
      ),
    ).not.toThrow();
  });

  test('rejects a fold without initial() (still a builder)', () => {
    const error = definitionError(() =>
      ContextFold.validate(ContextFold.of('conversation', { scope: 'run' })),
    );

    expect(error.foldName).toBe('conversation');
    expect(error.message).toBe(
      'ContextFold "conversation": missing initial(): call .initial(() => state) after ' +
        'ContextFold.of().',
    );
  });

  test.each([
    ['undefined', undefined, 'undefined'],
    ['a string', 'conversation', 'undefined'],
    ['an object with a name', { name: 'conversation', select: (s: unknown) => s }, 'conversation'],
    [
      'a source wrapping a fold (the removed FoldSource)',
      { name: 'chat', fold: conversation(), select: (s: unknown) => s },
      'chat',
    ],
  ])('rejects %s: only folds are folds', (_label, value, name) => {
    const error = definitionError(() => ContextFold.validate(value));

    expect(error.foldName).toBe(name);
    expect(error.message).toBe(
      `${JSON.stringify(name)} is not a fold: pass a ContextFold or a SegmentedFold.`,
    );
  });

  test('rejects a view with a hint naming its fold: views are functions of a read state', () => {
    const view = ContextView.of(conversation(), { measure: (state) => state.turns.length });

    const error = definitionError(() => ContextFold.validate(view));

    expect(error.foldName).toBe('conversation');
    expect(error.message).toBe(
      'a view of fold "conversation" (ContextView.of) is not a fold: declare "conversation" in ' +
        '.folds([...]), read it (await folds.conversation()) and call the view with the state ' +
        'and a budget.',
    );
  });

  test('rejects any other function by its name', () => {
    function chat() {}

    const error = definitionError(() => ContextFold.validate(chat));

    expect(error.foldName).toBe('chat');
    expect(error.message).toBe('"chat" is not a fold: pass a ContextFold or a SegmentedFold.');
  });
});

describe('AnyContextFold and FoldStateOf', () => {
  test('every fold is an AnyContextFold; FoldStateOf reads the state', () => {
    const fold = conversation();

    expectTypeOf(fold).toExtend<AnyContextFold>();
    expectTypeOf(compactable()).toExtend<AnyContextFold>();
    const asAny: AnyContextFold = fold;
    expect(asAny).toBe(fold);
    expectTypeOf<FoldStateOf<typeof fold>>().toEqualTypeOf<ConversationState>();
    expectTypeOf<FoldStateOf<AnyContextFold>>().toEqualTypeOf<unknown>();
    expectTypeOf<FoldScope>().toEqualTypeOf<'context' | 'run'>();
  });
});

describe('DeepReadonly', () => {
  test('makes objects, arrays and tuples read-only all the way down', () => {
    type Mutable = { turns: { text: string; tags: string[] }[]; pair: [number, { n: number }] };

    expectTypeOf<DeepReadonly<Mutable>>().toEqualTypeOf<{
      readonly turns: ReadonlyArray<{ readonly text: string; readonly tags: readonly string[] }>;
      readonly pair: readonly [number, { readonly n: number }];
    }>();
    const value: DeepReadonly<Mutable> = { turns: [{ text: 'a', tags: [] }], pair: [1, { n: 1 }] };
    // @ts-expect-error - read-only array
    void (() => value.turns.push({ text: 'b', tags: [] }));
    // @ts-expect-error - read-only nested property
    void (() => (value.pair[1].n = 2));
    expect(value.turns).toHaveLength(1);
  });

  test('keeps optional properties, index signatures and unions', () => {
    type Progress = { steps?: number; tally: Record<string, { results: string[] }> };

    expectTypeOf<DeepReadonly<Progress>>().toEqualTypeOf<{
      readonly steps?: number;
      readonly tally: { readonly [key: string]: { readonly results: readonly string[] } };
    }>();
    expectTypeOf<DeepReadonly<{ a: string[] } | number>>().toEqualTypeOf<
      { readonly a: readonly string[] } | number
    >();
  });

  test('Map and Set become ReadonlyMap and ReadonlySet', () => {
    expectTypeOf<DeepReadonly<Map<string, string[]>>>().toEqualTypeOf<
      ReadonlyMap<string, readonly string[]>
    >();
    expectTypeOf<DeepReadonly<Set<{ id: string }>>>().toEqualTypeOf<
      ReadonlySet<{ readonly id: string }>
    >();
  });

  test('leaves primitives, functions, unknown and any as they are', () => {
    expectTypeOf<DeepReadonly<number>>().toEqualTypeOf<number>();
    expectTypeOf<DeepReadonly<string | undefined>>().toEqualTypeOf<string | undefined>();
    expectTypeOf<DeepReadonly<boolean>>().toEqualTypeOf<boolean>();
    expectTypeOf<DeepReadonly<null>>().toEqualTypeOf<null>();
    expectTypeOf<DeepReadonly<(text: string) => number>>().toEqualTypeOf<
      (text: string) => number
    >();
    expectTypeOf<DeepReadonly<unknown>>().toEqualTypeOf<unknown>();
    // biome-ignore lint/suspicious/noExplicitAny: any stays any
    expectTypeOf<DeepReadonly<any>>().toBeAny();
    expectTypeOf<DeepReadonly<never>>().toBeNever();
  });

  test('leaves built-in instances as they are: Date, RegExp, Error, Promise, binary data', () => {
    type Built = {
      at: Date;
      pattern: RegExp;
      failure: Error;
      typed: TypeError;
      pending: Promise<string[]>;
      bytes: Uint8Array;
      buffer: ArrayBuffer;
      seen: WeakSet<object>;
      cache: WeakMap<object, string[]>;
    };

    expectTypeOf<DeepReadonly<Built>>().toEqualTypeOf<{
      readonly at: Date;
      readonly pattern: RegExp;
      readonly failure: Error;
      readonly typed: TypeError;
      readonly pending: Promise<string[]>;
      readonly bytes: Uint8Array;
      readonly buffer: ArrayBuffer;
      readonly seen: WeakSet<object>;
      readonly cache: WeakMap<object, string[]>;
    }>();
    const read: DeepReadonly<Built> = {} as Built;
    const at: Date = read.at;
    expect(at).toBeUndefined();
  });
});

describe('FoldReadStateOf: what a read of a fold resolves to', () => {
  test('a fold without a state schema reads as DeepReadonly of its state', () => {
    type Log = { entries: string[]; at: Date };
    const log = ContextFold.of('log')
      .initial((): Log => ({ entries: [], at: new Date(0) }))
      .on(UserPrompt, (l) => l);

    expectTypeOf<FoldReadStateOf<typeof log>>().toEqualTypeOf<DeepReadonly<Log>>();
    expectTypeOf<FoldReadStateOf<typeof log>>().toEqualTypeOf<{
      readonly entries: readonly string[];
      readonly at: Date;
    }>();
    expectTypeOf<FoldReadStateOf<ReturnType<typeof conversation>>>().toEqualTypeOf<
      DeepReadonly<ConversationState>
    >();
  });

  test('a fold with a state schema reads as the schema type, as it is', () => {
    class Author extends S.Class<Author>('Author')({ name: S.String }) {
      private readonly secret = 'kept';
      get initials() {
        return this.name.slice(0, 1) + this.secret.length;
      }
    }
    const Timeline = S.Struct({
      at: S.DateFromSelf,
      note: S.Option(S.String),
      author: Author,
      tags: S.Array(S.String),
    });
    const timeline = ContextFold.of('timeline', { state: Timeline })
      .initial(() =>
        Timeline.make({
          at: new Date(0),
          note: Option.none(),
          author: new Author({ name: 'a' }),
          tags: [],
        }),
      )
      .on(UserPrompt, (s) => s);

    type Read = FoldReadStateOf<typeof timeline>;
    expectTypeOf<Read>().toEqualTypeOf<typeof Timeline.Type>();
    expectTypeOf<Read['author']>().toEqualTypeOf<Author>();
    expectTypeOf<Read['note']>().toEqualTypeOf<Option.Option<string>>();
    // A class with private members is still its own type: it was not mapped.
    const author: Author = ({} as Read).author;
    expect(author).toBeUndefined();
    expect(timeline.initialState().author.initials).toBe('a4');
  });

  test('a segmented fold reads as its state: its data and summary come from schemas', () => {
    const notes = SegmentedFold.of('notes', { data: S.Struct({ at: S.DateFromSelf }) }).open(
      UserPrompt,
      () => ({ id: 'n', data: { at: new Date(0) } }),
    );

    expectTypeOf<FoldReadStateOf<typeof notes>>().toEqualTypeOf<
      SegmentedState<{ readonly at: Date }>
    >();
  });

  test('of any fold, unknown', () => {
    expectTypeOf<FoldReadStateOf<AnyContextFold>>().toEqualTypeOf<unknown>();
  });
});

describe('ContextFold types', () => {
  test('a builder only has initial(): handlers need the state type first', () => {
    const builder = ContextFold.of('conversation');

    // @ts-expect-error - handlers need the state type from initial()
    void (() => builder.on(UserPrompt, (state: number) => state));
    // @ts-expect-error - a builder is not a fold yet
    void (() => builder.initialState());
    expect(builder.initial(() => 0).name).toBe('conversation');
  });

  test('handlers must return the initial() state type', () => {
    const fold = ContextFold.of('count').initial(() => 0);

    // @ts-expect-error - the state is a number
    void (() => fold.on(UserPrompt, () => 'one'));
    // @ts-expect-error - the payload of UserPrompt has no summary
    void (() => fold.on(UserPrompt, (count, { payload }) => count + payload.summary.length));
    expect(fold.on(UserPrompt, (count) => count + 1).name).toBe('count');
  });

  test('an explicit initial<State>() type widens the inferred one', () => {
    const fold = ContextFold.of('names')
      .initial<readonly string[]>(() => [])
      .on(UserPrompt, (names, { payload }) => [...names, payload.text]);

    expectTypeOf<FoldStateOf<typeof fold>>().toEqualTypeOf<readonly string[]>();
    expect(fold.applyAll(fold.initialState(), [prompt('a'), prompt('b')])).toEqual(['a', 'b']);
  });

  test('a duplicate handler is a type error naming the event', () => {
    const fold = ContextFold.of('count')
      .initial(() => 0)
      .on(UserPrompt, (count) => count + 1);
    type On = Parameters<typeof fold.on<typeof UserPrompt>>[0];

    expectTypeOf<On>().toEqualTypeOf<typeof UserPrompt & DuplicateFoldHandler<'user-prompt'>>();
    expectTypeOf<Parameters<typeof fold.on<typeof ModelStep>>[0]>().toEqualTypeOf<
      typeof ModelStep
    >();
  });

  test('the type parameters track name, scope, state, handled events and the state schema', () => {
    const fold = compactable();

    expectTypeOf(fold).toEqualTypeOf<
      ContextFold<
        'conversation',
        'context',
        CompactableState,
        'user-prompt' | 'model-step',
        S.Schema<CompactableState, typeof ConversationSchema.Encoded>
      >
    >();
    expectTypeOf(fold.version).toEqualTypeOf<number>();
    expectTypeOf(fold).toExtend<
      ContextFoldBase<'conversation', 'context', CompactableState, 'user-prompt' | 'model-step'>
    >();
    expectTypeOf(conversation()).toEqualTypeOf<
      ContextFold<
        'conversation',
        'context',
        ConversationState,
        'user-prompt' | 'model-step' | 'tool-result'
      >
    >();
  });
});

describe('exports', () => {
  test('ContextFold and its types are exported by name from both entry points', () => {
    for (const entry of [root, matrix]) {
      expect(entry.ContextFold).toBe(ContextFold);
      expect(entry.ContextFoldDefinitionError).toBe(ContextFoldDefinitionError);
      for (const internal of [
        'ContextFoldImpl',
        'resolveFoldOptions',
        'foldDefinitionError',
        'foldStoredEvents',
        'foldEventDefinitions',
      ]) {
        expect(entry).not.toHaveProperty(internal);
      }
    }
    expectTypeOf<Root.AnyContextFold>().toEqualTypeOf<AnyContextFold>();
    expectTypeOf<Matrix.AnyContextFold>().toEqualTypeOf<AnyContextFold>();
    expectTypeOf<Root.FoldStateOf<AnyContextFold>>().toEqualTypeOf<unknown>();
    expectTypeOf<Matrix.DeepReadonly<string[]>>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<Root.DeepReadonly<{ a: number }>>().toEqualTypeOf<DeepReadonly<{ a: number }>>();
    expectTypeOf<Matrix.FoldReadStateOf<AnyContextFold>>().toEqualTypeOf<unknown>();
    expectTypeOf<Root.FoldReadStateOf<ReturnType<typeof conversation>>>().toEqualTypeOf<
      FoldReadStateOf<ReturnType<typeof conversation>>
    >();
    expectTypeOf<Root.FoldScope>().toEqualTypeOf<FoldScope>();
    expectTypeOf<Matrix.FoldScope>().toEqualTypeOf<FoldScope>();
    expectTypeOf<Root.ContextFoldOptions>().toEqualTypeOf<ContextFoldOptions>();
    expectTypeOf<Matrix.ContextFoldOptions<'run'>>().toEqualTypeOf<ContextFoldOptions<'run'>>();
    expectTypeOf<Root.ContextFoldBuilder<'a'>>().toEqualTypeOf<ContextFoldBuilder<'a'>>();
    expectTypeOf<Matrix.ContextFoldBuilder<'a'>>().toEqualTypeOf<ContextFoldBuilder<'a'>>();
    expectTypeOf<Root.DuplicateFoldHandler<'a'>>().toEqualTypeOf<DuplicateFoldHandler<'a'>>();
    expectTypeOf<Matrix.DuplicateFoldHandler<'a'>>().toEqualTypeOf<DuplicateFoldHandler<'a'>>();
    expectTypeOf<Root.UnhandledFoldEvent<typeof UserPrompt, 'user-prompt'>>().toEqualTypeOf<
      DuplicateFoldHandler<'user-prompt'>
    >();
    expectTypeOf<Matrix.UnhandledFoldEvent<typeof UserPrompt, never>>().toEqualTypeOf<unknown>();
    expectTypeOf<UnhandledFoldEvent<typeof ModelStep, 'model-step'>>().toEqualTypeOf<
      DuplicateFoldHandler<'model-step'>
    >();
    expectTypeOf<Root.ContextFoldBase<'a', 'run', number>>().toEqualTypeOf<
      ContextFoldBase<'a', 'run', number>
    >();
    expectTypeOf<Matrix.ContextFoldBase<'a', 'run', number>>().toEqualTypeOf<
      ContextFoldBase<'a', 'run', number>
    >();
    expectTypeOf<Root.ValidFoldName<'chat'>>().toEqualTypeOf<ValidFoldName<'chat'>>();
    expectTypeOf<Matrix.ValidFoldName<'chat-view'>>().toEqualTypeOf<InvalidFoldName<'chat-view'>>();
    expectTypeOf<Root.InvalidFoldName<'1st'>>().toEqualTypeOf<InvalidFoldName<'1st'>>();
    expectTypeOf<Matrix.InvalidFoldName<'1st'>>().toEqualTypeOf<InvalidFoldName<'1st'>>();
  });

  test('the over() stage, the completeness and the checkpointOn types are gone', () => {
    // @ts-expect-error - removed with .checkpointOn(): checkpoints are core events
    expectTypeOf<Root.CheckpointAlreadyDeclared<'a'>>().toBeAny();
    // @ts-expect-error - removed with .checkpointOn()
    expectTypeOf<Matrix.CheckpointEventAllowed<typeof ModelStep, never, never>>().toBeAny();
    // @ts-expect-error - removed: the handlers define the events
    expectTypeOf<Root.ContextFoldEventsBuilder>().toBeAny();
    // @ts-expect-error - removed: there is no over() list to complete
    expectTypeOf<Matrix.MissingFoldHandlers>().toBeAny();
  });
});
