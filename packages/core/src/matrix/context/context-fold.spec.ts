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
  type ContextFoldBuilder,
  ContextFoldDefinitionError,
  type FoldResultOf,
  type FoldScope,
  type FoldSource,
  type FoldStateOf,
  type InvalidFoldName,
  type ValidFoldName,
} from './context-fold.js';

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
const ContextCompacted = AgentNetworkEvent.of('context-compacted', S.Struct({ summary: S.String }));
const Unrelated = AgentNetworkEvent.of('unrelated', S.Struct({ value: S.Number }));

type Turn = { readonly role: 'user' | 'assistant' | 'tool' | 'summary'; readonly text: string };
type ConversationState = { readonly turns: readonly Turn[] };

const meta = { runId: 'run-1', contextId: 'ctx-1' };
const prompt = (text: string) => UserPrompt.makeBound(meta, { text });

describe('ContextFold builder', () => {
  test('builds a fold with its name, version, default context scope and event names', () => {
    const fold = ContextFold.of('conversation', { version: 1 })
      .over([UserPrompt, ModelStep])
      .initial((): ConversationState => ({ turns: [] }));

    expect(fold.name).toBe('conversation');
    expect(fold.version).toBe(1);
    expect(fold.scope).toBe('context');
    expect(fold.eventNames).toEqual(['user-prompt', 'model-step']);
    expect(fold.checkpointEventName).toBeUndefined();

    expectTypeOf(fold.name).toEqualTypeOf<'conversation'>();
    expectTypeOf(fold.scope).toEqualTypeOf<'context'>();
    expectTypeOf(fold.eventNames).toEqualTypeOf<ReadonlyArray<'user-prompt' | 'model-step'>>();
  });

  test('takes a run scope before or after over()', () => {
    const before = ContextFold.of('steps', { version: 2 })
      .scope('run')
      .over([ModelStep])
      .initial(() => 0);
    const after = ContextFold.of('steps', { version: 2 })
      .over([ModelStep])
      .scope('run')
      .initial(() => 0);

    expect(before.scope).toBe('run');
    expect(after.scope).toBe('run');
    expectTypeOf(before.scope).toEqualTypeOf<'run'>();
    expectTypeOf(after.scope).toEqualTypeOf<'run'>();
  });

  test('builders are immutable: each step returns a new builder', () => {
    const base = ContextFold.of('conversation', { version: 1 });
    const scoped = base.scope('run');
    const a = base.over([UserPrompt]).initial(() => 0);
    const b = scoped.over([UserPrompt]).initial(() => 0);

    expect(scoped).not.toBe(base);
    expect(a.scope).toBe('context');
    expect(b.scope).toBe('run');
  });

  test('initialState() calls initial() on every cold start (a fresh state each time)', () => {
    const fold = ContextFold.of('conversation', { version: 1 })
      .over([UserPrompt])
      .initial((): ConversationState => ({ turns: [] }))
      .on(UserPrompt, (state, { payload }) => ({
        turns: [...state.turns, { role: 'user', text: payload.text }],
      }));

    const first = fold.initialState();
    const second = fold.initialState();

    expect(first).toEqual({ turns: [] });
    expect(second).not.toBe(first);
    expectTypeOf(first).toEqualTypeOf<ConversationState>();
  });
});

const step = (stepId: string, text: string) => ModelStep.makeBound(meta, { stepId, text });
const toolResult = (stepId: string, output: string) =>
  ToolResult.makeBound(meta, { stepId, output });
const compacted = (summary: string) => ContextCompacted.makeBound(meta, { summary });

/** A complete fold over every fixture event but the checkpoint one. */
const conversation = () =>
  ContextFold.of('conversation', { version: 1 })
    .over([UserPrompt, ModelStep, ToolResult])
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

    expect(fold.apply(state, compacted('ignored'))).toBe(state);
    expect(fold.apply(state, { name: 'unknown', meta, payload: {} })).toBe(state);
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

/** The conversation fold, compacted by `context-compacted` checkpoints. */
const compactable = () =>
  ContextFold.of('conversation', { version: 1 })
    .over([UserPrompt, ModelStep, ContextCompacted])
    .initial((): ConversationState => ({ turns: [] }))
    .on(UserPrompt, (state, { payload }) => ({
      turns: [...state.turns, { role: 'user', text: payload.text }],
    }))
    .on(ModelStep, (state, { payload }) => ({
      turns: [...state.turns, { role: 'assistant', text: payload.text }],
    }))
    .checkpointOn(ContextCompacted, (envelope) => {
      expectTypeOf(envelope).toEqualTypeOf<EventEnvelope<typeof ContextCompacted>>();
      return { turns: [{ role: 'summary', text: envelope.payload.summary }] };
    });

describe('ContextFold checkpoints', () => {
  test('exposes the checkpoint event name; eventNames still lists every over event', () => {
    const fold = compactable();

    expect(fold.checkpointEventName).toBe('context-compacted');
    expect(fold.eventNames).toEqual(['user-prompt', 'model-step', 'context-compacted']);
    expectTypeOf(fold.checkpointEventName).toEqualTypeOf<'context-compacted'>();
  });

  test('applying the checkpoint event replaces the state with checkpoint(envelope)', () => {
    const fold = compactable();

    const state = fold.applyAll(fold.initialState(), [
      prompt('long question'),
      step('s1', 'long answer'),
      compacted('asked a question, got an answer'),
      prompt('follow-up'),
    ]);

    expect(state.turns).toEqual([
      { role: 'summary', text: 'asked a question, got an answer' },
      { role: 'user', text: 'follow-up' },
    ]);
  });

  test('a cold read from the newest checkpoint folds to the same state as the full history', () => {
    const fold = compactable();
    const history = [
      prompt('one'),
      compacted('first summary'),
      prompt('two'),
      compacted('second summary'),
      step('s1', 'three'),
    ];

    const full = fold.applyAll(fold.initialState(), history);
    const fromCheckpoint = fold.applyAll(fold.initialState(), history.slice(3));

    expect(fromCheckpoint).toEqual(full);
  });
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
    const error = definitionError(() => ContextFold.of(name, { version: 1 }));

    expect(error.foldName).toBe(name);
    expect(error.message).toContain(JSON.stringify(name));
    expect(error.message).toContain('identifier');
  });

  test('rejects invalid literal names at type level; inference of the name is unchanged', () => {
    // @ts-expect-error - a fold name must be a JS identifier (it is a ctx.folds key)
    expect(() => ContextFold.of('chat-view', { version: 1 })).toThrow(ContextFoldDefinitionError);
    // @ts-expect-error - a fold name cannot start with a digit
    expect(() => ContextFold.of('1st', { version: 1 })).toThrow(ContextFoldDefinitionError);
    // @ts-expect-error - __proto__ would set the prototype of ctx.folds
    expect(() => ContextFold.of('__proto__', { version: 1 })).toThrow(ContextFoldDefinitionError);

    const fold = ContextFold.of('chatV2', { version: 1 })
      .over([UserPrompt])
      .initial(() => 0)
      .on(UserPrompt, (count) => count + 1);
    expectTypeOf(fold.name).toEqualTypeOf<'chatV2'>();
    expectTypeOf(ContextFold.of('$steps', { version: 1 })).toEqualTypeOf<
      ContextFoldBuilder<'$steps'>
    >();
    const dynamic: string = 'conversation';
    expectTypeOf(ContextFold.of(dynamic, { version: 1 })).toEqualTypeOf<
      ContextFoldBuilder<string>
    >();
  });

  test.each([
    'conversation',
    'chatV2',
    '_internal',
    '$steps',
    'a',
  ])('accepts the name %j', (name) => {
    expect(
      ContextFold.of(name, { version: 1 })
        .over([UserPrompt])
        .initial(() => 0).name,
    ).toBe(name);
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
    expect(error.message).toContain('positive integer');
  });

  test('rejects an unknown scope', () => {
    const error = definitionError(() =>
      // @ts-expect-error - only 'context' and 'run' are scopes
      ContextFold.of('conversation', { version: 1 }).scope('session'),
    );

    expect(error.message).toContain('"session"');
  });

  test('rejects an empty over() and initial() before over()', () => {
    const builder = ContextFold.of('conversation', { version: 1 });

    expect(definitionError(() => builder.over([])).message).toContain('at least one event');
    expect(
      definitionError(() =>
        // @ts-expect-error - initial() is only available after over()
        builder.initial(() => 0),
      ).message,
    ).toContain('over()');
  });

  test('rejects an event listed twice in over()', () => {
    const error = definitionError(() =>
      ContextFold.of('conversation', { version: 1 }).over([UserPrompt, ModelStep, UserPrompt]),
    );

    expect(error.message).toContain('"user-prompt"');
    expect(error.message).toContain('twice');
  });

  test('rejects a handler for an event that is not in over()', () => {
    const fold = ContextFold.of('conversation', { version: 1 })
      .over([UserPrompt])
      .initial(() => 0);

    const error = definitionError(() =>
      // @ts-expect-error - Unrelated is not one of the over() events
      fold.on(Unrelated, (count) => count + 1),
    );

    expect(error.message).toContain('"unrelated"');
    expect(error.message).toContain('over()');
  });

  test('rejects a second handler for the same event', () => {
    const fold = ContextFold.of('conversation', { version: 1 })
      .over([UserPrompt, ModelStep])
      .initial(() => 0)
      .on(UserPrompt, (count) => count + 1);

    const error = definitionError(() =>
      // @ts-expect-error - UserPrompt already has a handler
      fold.on(UserPrompt, (count) => count + 2),
    );

    expect(error.message).toContain('"user-prompt"');
    expect(error.message).toContain('already');
  });

  test('rejects a handler for the checkpoint event and a checkpoint for a handled event', () => {
    const base = ContextFold.of('conversation', { version: 1 })
      .over([UserPrompt, ContextCompacted])
      .initial(() => 0);

    const handlerAfterCheckpoint = definitionError(() =>
      base
        .checkpointOn(ContextCompacted, () => 0)
        // @ts-expect-error - ContextCompacted is already the checkpoint event
        .on(ContextCompacted, (count) => count + 1),
    );
    const checkpointAfterHandler = definitionError(() =>
      base
        .on(UserPrompt, (count) => count + 1)
        // @ts-expect-error - UserPrompt already has an .on() handler
        .checkpointOn(UserPrompt, () => 0),
    );

    expect(handlerAfterCheckpoint.message).toContain('"context-compacted"');
    expect(handlerAfterCheckpoint.message).toContain('checkpoint');
    expect(checkpointAfterHandler.message).toContain('"user-prompt"');
    expect(checkpointAfterHandler.message).toContain('already');
  });

  test('rejects a checkpoint event that is not in over()', () => {
    const fold = ContextFold.of('conversation', { version: 1 })
      .over([UserPrompt])
      .initial(() => 0);

    const error = definitionError(() =>
      // @ts-expect-error - ContextCompacted is not one of the over() events
      fold.checkpointOn(ContextCompacted, () => 0),
    );

    expect(error.message).toContain('"context-compacted"');
    expect(error.message).toContain('over()');
  });

  test('rejects a second checkpoint event', () => {
    const fold = ContextFold.of('conversation', { version: 1 })
      .over([UserPrompt, ModelStep, ContextCompacted])
      .initial(() => 0)
      .checkpointOn(ContextCompacted, () => 0);

    const error = definitionError(() =>
      // @ts-expect-error - a fold has at most one checkpoint event
      fold.checkpointOn(ModelStep, () => 0),
    );

    expect(error.message).toContain('"context-compacted"');
    expect(error.message).toContain('one checkpoint');
  });
});

describe('ContextFold completeness', () => {
  /** Handles UserPrompt only: ModelStep and ToolResult have no handler. */
  const incomplete = () =>
    ContextFold.of('conversation', { version: 1 })
      .over([UserPrompt, ModelStep, ToolResult])
      .initial((): ConversationState => ({ turns: [] }))
      .on(UserPrompt, (state) => state);

  test('a complete fold is an AnyContextFold and a FoldSource of its own state', () => {
    const fold = conversation();

    expectTypeOf(fold).toExtend<AnyContextFold>();
    expectTypeOf(fold).toExtend<FoldSource<'conversation', ConversationState>>();
    expectTypeOf(compactable()).toExtend<AnyContextFold>();
    const asAny: AnyContextFold = fold;
    const asSource: FoldSource = fold;
    expect(asAny).toBe(fold);
    expect(asSource).toBe(fold);
  });

  test('a fold whose remaining event is the checkpoint event is complete', () => {
    const fold = ContextFold.of('summary', { version: 1 })
      .over([UserPrompt, ContextCompacted])
      .initial(() => '')
      .on(UserPrompt, (text, { payload }) => `${text}\n${payload.text}`)
      .checkpointOn(ContextCompacted, ({ payload }) => payload.summary);

    expectTypeOf(fold).toExtend<AnyContextFold>();
    expect(() => ContextFold.validate(fold)).not.toThrow();
  });

  test('an incomplete fold is neither an AnyContextFold nor a FoldSource', () => {
    const fold = incomplete();

    expectTypeOf(fold).not.toExtend<AnyContextFold>();
    expectTypeOf(fold).not.toExtend<FoldSource>();
    // @ts-expect-error - ModelStep and ToolResult have no handler yet
    const asAny: AnyContextFold = fold;
    // @ts-expect-error - a source must wrap a complete fold
    const asSource: FoldSource = fold;
    void [asAny, asSource];
  });

  test('an incomplete fold throws on first use, naming every event without a handler', () => {
    const fold = incomplete();

    for (const use of [
      () => fold.initialState(),
      () => fold.apply({ turns: [] }, prompt('hi')),
      () => fold.applyAll({ turns: [] }, []),
    ]) {
      const error = definitionError(use);
      expect(error.foldName).toBe('conversation');
      expect(error.message).toContain('"model-step", "tool-result"');
      expect(error.message).toContain('.on()');
    }
  });

  test('validate() accepts complete folds and asserts the FoldSource type', () => {
    const source: unknown = conversation();

    ContextFold.validate(source);

    expectTypeOf(source).toEqualTypeOf<FoldSource>();
    expect(source.name).toBe('conversation');
  });

  test('validate() rejects an incomplete fold without having used it', () => {
    const error = definitionError(() => ContextFold.validate(incomplete()));

    expect(error.message).toContain('"model-step", "tool-result"');
  });

  test('validate() rejects a fold without initial() (still a builder)', () => {
    const builder = ContextFold.of('conversation', { version: 1 }).over([UserPrompt]);

    const error = definitionError(() => ContextFold.validate(builder));

    expect(error.foldName).toBe('conversation');
    expect(error.message).toContain('initial()');
  });

  test.each([
    ['undefined', undefined],
    ['a string', 'conversation'],
    ['an object without a fold', { name: 'conversation', select: (s: unknown) => s }],
  ])('validate() rejects %s', (_label, value) => {
    const error = definitionError(() => ContextFold.validate(value));

    expect(error.message).toContain('not a fold source');
  });

  test('validate() checks a source wrapping a fold: its name, select and the fold itself', () => {
    const fold = conversation();
    const view = { name: 'chat', fold, select: (state: unknown) => state };
    const badName = { ...view, name: 'chat-view' };
    const noSelect = { name: 'chat', fold };
    const incompleteBase = { ...view, fold: incomplete() };

    ContextFold.validate(view);
    expect(definitionError(() => ContextFold.validate(badName)).message).toContain('identifier');
    expect(definitionError(() => ContextFold.validate(noSelect)).message).toContain('select');
    expect(definitionError(() => ContextFold.validate(incompleteBase)).message).toContain(
      '"model-step", "tool-result"',
    );
  });
});

describe('ContextFold as a FoldSource', () => {
  test('a fold is its own source: name = fold name, fold = itself, select = identity', () => {
    const fold = conversation();
    const state = fold.applyAll(fold.initialState(), [prompt('hi')]);

    expect(fold.fold).toBe(fold);
    expect(fold.select(state)).toBe(state);
    expectTypeOf(fold.select).returns.toEqualTypeOf<ConversationState>();
  });

  test('FoldStateOf and FoldResultOf read the state and the select result', () => {
    const fold = conversation();
    const view: FoldSource<'chat', { readonly count: number }> = {
      name: 'chat',
      fold,
      select: async (state) => ({ count: (state as ConversationState).turns.length }),
    };

    expectTypeOf<FoldStateOf<typeof fold>>().toEqualTypeOf<ConversationState>();
    expectTypeOf<FoldStateOf<AnyContextFold>>().toEqualTypeOf<unknown>();
    expectTypeOf<FoldResultOf<typeof fold>>().toEqualTypeOf<ConversationState>();
    expectTypeOf<FoldResultOf<typeof view>>().toEqualTypeOf<{ readonly count: number }>();
    expectTypeOf<FoldResultOf<FoldSource>>().toEqualTypeOf<unknown>();
    expectTypeOf<FoldScope>().toEqualTypeOf<'context' | 'run'>();
  });
});

describe('ContextFold types', () => {
  test('the builder stages only expose what is valid next', () => {
    const builder = ContextFold.of('conversation', { version: 1 });
    const withEvents = builder.over([UserPrompt]);

    // @ts-expect-error - handlers need the state type from initial()
    void (() => withEvents.on(UserPrompt, (state: number) => state));
    // @ts-expect-error - a builder is not a fold yet
    void (() => builder.initialState());
    // @ts-expect-error - over() is given once
    void (() => withEvents.over([ModelStep]));
    expect(withEvents.initial(() => 0).name).toBe('conversation');
  });

  test('handlers must return the initial() state type', () => {
    const fold = ContextFold.of('count', { version: 1 })
      .over([UserPrompt, ContextCompacted])
      .initial(() => 0);

    // @ts-expect-error - the state is a number
    void (() => fold.on(UserPrompt, () => 'one'));
    // @ts-expect-error - the checkpoint must restore a number
    void (() => fold.checkpointOn(ContextCompacted, ({ payload }) => payload.summary));
    // @ts-expect-error - the payload of UserPrompt has no summary
    void (() => fold.on(UserPrompt, (count, { payload }) => count + payload.summary.length));
    expect(fold.on(UserPrompt, (count) => count + 1).name).toBe('count');
  });

  test('an explicit initial<State>() type widens the inferred one', () => {
    const fold = ContextFold.of('names', { version: 1 })
      .over([UserPrompt])
      .initial<readonly string[]>(() => [])
      .on(UserPrompt, (names, { payload }) => [...names, payload.text]);

    expectTypeOf<FoldStateOf<typeof fold>>().toEqualTypeOf<readonly string[]>();
    expect(fold.applyAll(fold.initialState(), [prompt('a'), prompt('b')])).toEqual(['a', 'b']);
  });

  test('the type parameters track name, scope, events, handled and checkpoint events', () => {
    const fold = compactable();

    expectTypeOf(fold).toEqualTypeOf<
      ContextFold<
        'conversation',
        'context',
        typeof UserPrompt | typeof ModelStep | typeof ContextCompacted,
        ConversationState,
        'user-prompt' | 'model-step',
        'context-compacted'
      >
    >();
    expectTypeOf(fold.version).toEqualTypeOf<number>();
    expectTypeOf(fold.fold).toEqualTypeOf(fold);
  });
});

describe('exports', () => {
  test('ContextFold and its types are exported by name from both entry points', () => {
    for (const entry of [root, matrix]) {
      expect(entry.ContextFold).toBe(ContextFold);
      expect(entry.ContextFoldDefinitionError).toBe(ContextFoldDefinitionError);
    }
    expectTypeOf<Root.AnyContextFold>().toEqualTypeOf<AnyContextFold>();
    expectTypeOf<Matrix.AnyContextFold>().toEqualTypeOf<AnyContextFold>();
    expectTypeOf<Root.FoldSource<'a', number>>().toEqualTypeOf<FoldSource<'a', number>>();
    expectTypeOf<Matrix.FoldSource<'a', number>>().toEqualTypeOf<FoldSource<'a', number>>();
    expectTypeOf<Root.FoldStateOf<AnyContextFold>>().toEqualTypeOf<unknown>();
    expectTypeOf<Matrix.FoldResultOf<FoldSource<'a', number>>>().toEqualTypeOf<number>();
    expectTypeOf<Root.FoldScope>().toEqualTypeOf<FoldScope>();
    expectTypeOf<Matrix.FoldScope>().toEqualTypeOf<FoldScope>();
    expectTypeOf<Root.ValidFoldName<'chat'>>().toEqualTypeOf<ValidFoldName<'chat'>>();
    expectTypeOf<Matrix.ValidFoldName<'chat-view'>>().toEqualTypeOf<InvalidFoldName<'chat-view'>>();
    expectTypeOf<Root.InvalidFoldName<'1st'>>().toEqualTypeOf<InvalidFoldName<'1st'>>();
    expectTypeOf<Matrix.InvalidFoldName<'1st'>>().toEqualTypeOf<InvalidFoldName<'1st'>>();
  });
});
