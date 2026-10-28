import { Either } from 'effect';
import { describe, expect, expectTypeOf, test } from 'vitest';
import type * as Root from '../../index.js';
import * as root from '../../index.js';
import { AgentNetworkEvent, type EventMeta, S } from '../agent-network/agent-network-event.js';
import { isReservedEventName } from '../agent-network/run-lifecycle.js';
import type * as Matrix from '../index.js';
import * as matrix from '../index.js';
import { ContextFold } from './context-fold.js';
import {
  encodeFoldCheckpointState,
  type FoldCheckpointEnvelope,
  type FoldCheckpointEventName,
  type FoldCheckpointPayload,
  FoldCompactionError,
  foldCheckpointEventName,
  isFoldCheckpointEvent,
  restoreFoldCheckpoint,
} from './fold-checkpoint.js';
import { SegmentedFold } from './segmented-fold.js';

const UserPrompt = AgentNetworkEvent.of('user-prompt', S.Struct({ text: S.String }));

const meta: EventMeta = { runId: 'run-1', contextId: 'ctx-1' };

describe('foldCheckpointEventName', () => {
  test('is m4trix:fold.checkpoint:<name>@<version>: reserved, one per fold name and version', () => {
    expect(foldCheckpointEventName({ name: 'conversation', version: 1 })).toBe(
      'm4trix:fold.checkpoint:conversation@1',
    );
    expect(foldCheckpointEventName({ name: 'conversation', version: 12 })).toBe(
      'm4trix:fold.checkpoint:conversation@12',
    );
    expect(isReservedEventName(foldCheckpointEventName({ name: 'a', version: 1 }))).toBe(true);
    expectTypeOf(
      foldCheckpointEventName({ name: 'conversation' as const, version: 1 }),
    ).toEqualTypeOf<FoldCheckpointEventName<'conversation'>>();
  });

  test('a fold that can compact names its own: the same name', () => {
    const fold = ContextFold.of('log', { state: S.Array(S.String), version: 3 })
      .initial(() => [])
      .on(UserPrompt, (lines, { payload }) => [...lines, payload.text]);
    const segmented = SegmentedFold.of('chat', { data: S.String }).open(
      UserPrompt,
      ({ payload }) => ({
        id: payload.text,
        data: payload.text,
      }),
    );

    expect(fold.checkpointEventName).toBe(foldCheckpointEventName(fold));
    expect(segmented.checkpointEventName).toBe(foldCheckpointEventName(segmented));
  });

  test('user events cannot take the name: the m4trix: prefix is reserved', () => {
    expect(() =>
      AgentNetworkEvent.of(foldCheckpointEventName({ name: 'chat', version: 1 }), S.Struct({})),
    ).toThrow(/reserved/);
  });
});

describe('isFoldCheckpointEvent', () => {
  const checkpoint: FoldCheckpointEnvelope = {
    name: 'm4trix:fold.checkpoint:conversation@1',
    meta,
    payload: { fold: 'conversation', version: 1, through: null, state: { turns: [] } },
  };

  test('tells checkpoints of any fold from other events, by name', () => {
    expect(isFoldCheckpointEvent(checkpoint)).toBe(true);
    expect(isFoldCheckpointEvent({ ...checkpoint, name: 'm4trix:fold.checkpoint:chat@7' })).toBe(
      true,
    );
    for (const name of ['user-prompt', 'm4trix:run.completed', 'm4trix:fold.checkpoint']) {
      expect(isFoldCheckpointEvent({ name, meta, payload: {} })).toBe(false);
    }
  });

  test('narrows to the checkpoint envelope', () => {
    const event: { name: string; meta: EventMeta; payload: unknown } = checkpoint;

    if (isFoldCheckpointEvent(event)) {
      expectTypeOf(event.payload).toEqualTypeOf<FoldCheckpointPayload>();
      expectTypeOf(event.name).toEqualTypeOf<FoldCheckpointEventName>();
    }
    expectTypeOf<FoldCheckpointPayload>().toEqualTypeOf<{
      readonly fold: string;
      readonly version: number;
      readonly through: string | null;
      readonly state: unknown;
    }>();
    expectTypeOf<
      FoldCheckpointEventName<'a'>
    >().toEqualTypeOf<`m4trix:fold.checkpoint:a@${number}`>();
  });
});

describe('encodeFoldCheckpointState', () => {
  const Since = ContextFold.of('since', {
    state: S.Struct({ first: S.Date, lines: S.Array(S.String) }),
  })
    .initial(() => ({ first: new Date(0), lines: [] }))
    .on(UserPrompt, (state, { payload }) => ({ ...state, lines: [...state.lines, payload.text] }));

  test('is the state encoded with the state schema, as a frozen JSON copy of its own', () => {
    const state = { first: new Date('2026-01-01T00:00:00.000Z'), lines: ['a'] };

    const encoded = encodeFoldCheckpointState(Since, state) as { lines: string[] };

    expect(encoded).toEqual({ first: '2026-01-01T00:00:00.000Z', lines: ['a'] });
    expect(Object.isFrozen(encoded)).toBe(true);
    expect(Object.isFrozen(encoded.lines)).toBe(true);
    expect(encoded.lines).not.toBe(state.lines);
  });

  test('a state whose encoded form is not JSON is an invalid-state FoldCompactionError', () => {
    const Raw = ContextFold.of('raw', { state: S.Struct({ at: S.DateFromSelf }) })
      .initial(() => ({ at: new Date(0) }))
      .on(UserPrompt, (state) => state);

    let error: unknown;
    try {
      encodeFoldCheckpointState(Raw, { at: new Date(0) });
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(FoldCompactionError);
    expect(error).toMatchObject({ foldName: 'raw', reason: 'invalid-state' });
    expect((error as Error).message).toBe(
      "folds.raw.compact(): the new state does not encode to JSON with the fold's state schema " +
        '(checkpoints are stored as JSON): the value at at is not JSON-compatible: a Date',
    );
  });

  test('a Date in an S.Unknown part of the state is stored as its ISO string (its toJSON)', () => {
    const Notes = ContextFold.of('notes', { state: S.Struct({ outputs: S.Array(S.Unknown) }) })
      .initial(() => ({ outputs: [] }))
      .on(UserPrompt, (state) => state);

    const encoded = encodeFoldCheckpointState(Notes, {
      outputs: [{ createdAt: new Date('2026-01-01T00:00:00.000Z') }],
    });

    expect(encoded).toEqual({ outputs: [{ createdAt: '2026-01-01T00:00:00.000Z' }] });
    expect(Object.isFrozen(encoded)).toBe(true);
  });

  test('a state whose getter throws while it is copied is an invalid-state FoldCompactionError', () => {
    const Notes = ContextFold.of('notes', { state: S.Struct({ outputs: S.Array(S.Unknown) }) })
      .initial(() => ({ outputs: [] }))
      .on(UserPrompt, (state) => state);
    const broken = {
      get value(): never {
        throw new RangeError('getter failed');
      },
    };

    let error: unknown;
    try {
      encodeFoldCheckpointState(Notes, { outputs: [broken] });
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(FoldCompactionError);
    expect(error).toMatchObject({
      reason: 'invalid-state',
      cause: {
        path: 'outputs[0].value',
        what: 'a getter that threw',
        cause: expect.any(RangeError),
      },
    });
    expect((error as Error).message).toContain(
      'the value at outputs[0].value is not JSON-compatible: a getter that threw',
    );
  });
});

describe('restoreFoldCheckpoint', () => {
  const event = (state: unknown) => ({
    name: 'm4trix:fold.checkpoint:log@1',
    meta,
    payload: { fold: 'log', version: 1, through: 'c1', state },
  });

  test('a state schema that does not transform restores the stored state itself', () => {
    const stored = Object.freeze(['a', 'b']);

    const restored = Either.getOrThrow(restoreFoldCheckpoint(S.Array(S.String), event(stored)));

    expect(restored).toEqual({ state: stored, through: 'c1' });
    expect(restored.state).toBe(stored);
  });

  test('a transforming state schema decodes it; a state it rejects is a Left', () => {
    const schema = S.Struct({ n: S.NumberFromString });

    expect(Either.getOrThrow(restoreFoldCheckpoint(schema, event({ n: '3' }))).state).toEqual({
      n: 3,
    });
    expect(Either.isLeft(restoreFoldCheckpoint(schema, event({ n: 3 })))).toBe(true);
  });
});

describe('exports', () => {
  test('the helpers and types are public on both entry points', () => {
    for (const entry of [root, matrix]) {
      expect(entry.foldCheckpointEventName).toBe(foldCheckpointEventName);
      expect(entry.isFoldCheckpointEvent).toBe(isFoldCheckpointEvent);
    }
    expectTypeOf<Root.FoldCheckpointPayload>().toEqualTypeOf<FoldCheckpointPayload>();
    expectTypeOf<Matrix.FoldCheckpointEnvelope>().toEqualTypeOf<FoldCheckpointEnvelope>();
    expectTypeOf<Root.FoldCheckpointEventName<'x'>>().toEqualTypeOf<FoldCheckpointEventName<'x'>>();
  });
});
