import { Data, Either, Option, ParseResult, Redacted, Schema as S } from 'effect';
import { describe, expect, test } from 'vitest';
import * as root from '../../index.js';
import * as matrix from '../index.js';
import {
  decodeStoredPayload,
  decodeWirePayload,
  encodeForWire,
  encodePayload,
  isTransformingSchema,
  NotJsonCompatibleError,
  redactedIn,
  storedFormOf,
  storedJsonOf,
  toStoredJson,
  unstorableIn,
  wireSchemaOf,
} from './stored-payload.js';

const deepFrozen = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
};

const notJson = (value: unknown): NotJsonCompatibleError => {
  try {
    toStoredJson(value);
  } catch (error) {
    if (error instanceof NotJsonCompatibleError) return error;
    throw error;
  }
  throw new Error('toStoredJson accepted the value');
};

describe('toStoredJson', () => {
  test('copies JSON values deeply: equal content, no shared objects, everything frozen', () => {
    const inner = { list: [1, 'two', true, null, { deep: -1.5 }], empty: {}, none: [] };
    const value = { text: 'hi ✓', inner };

    const copy = toStoredJson(value) as typeof value;

    expect(copy).toEqual(value);
    expect(copy).not.toBe(value);
    expect(copy.inner).not.toBe(inner);
    expect(copy.inner.list).not.toBe(inner.list);
    expect(deepFrozen(copy)).toBe(true);
    // The original is left as it was.
    expect(Object.isFrozen(value)).toBe(false);
    inner.list.push('later');
    expect(copy.inner.list).toHaveLength(5);
  });

  test('is what JSON.parse(JSON.stringify(value)) gives: undefined properties are left out', () => {
    const value = { a: 1, b: undefined, c: { d: undefined, e: 'x' } };

    expect(toStoredJson(value)).toEqual(JSON.parse(JSON.stringify(value)));
    expect(Object.keys(toStoredJson(value) as object)).toEqual(['a', 'c']);
  });

  test('primitives and a missing payload pass as they are', () => {
    expect(toStoredJson('text')).toBe('text');
    expect(toStoredJson(0)).toBe(0);
    expect(toStoredJson(false)).toBe(false);
    expect(toStoredJson(null)).toBe(null);
    expect(toStoredJson(undefined)).toBe(undefined);
  });

  test('keeps a __proto__ key as data, like JSON.parse', () => {
    const value = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as object;

    const copy = toStoredJson(value) as Record<string, unknown>;

    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.keys(copy)).toEqual(['__proto__', 'a']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify(copy)).toBe(JSON.stringify(value));
  });

  test('objects without a prototype are plain data too', () => {
    const value = Object.assign(Object.create(null) as object, { a: 1 });

    expect(toStoredJson(value)).toEqual({ a: 1 });
  });

  test('calls toJSON as JSON.stringify does: a Date is its ISO string, a Decimal its own form', () => {
    class Decimal {
      constructor(readonly digits: string) {}
      toJSON(): string {
        return this.digits;
      }
    }
    const value = {
      at: new Date(Date.UTC(2026, 0, 2)),
      price: new Decimal('19.99'),
      list: [new Date(0)],
      nested: { invalid: new Date(Number.NaN) },
    };

    const copy = toStoredJson(value);

    expect(copy).toEqual({
      at: '2026-01-02T00:00:00.000Z',
      price: '19.99',
      list: ['1970-01-01T00:00:00.000Z'],
      nested: { invalid: null },
    });
    expect(copy).toEqual(JSON.parse(JSON.stringify(value)));
    expect(deepFrozen(copy)).toBe(true);
  });

  test('toJSON gets the key, and what it returns is copied by the same rules', () => {
    const keyed = { toJSON: (key: string) => `key "${key}"` };
    // Called once per value: what it returns is not asked for its own toJSON again.
    const wrapping = { toJSON: () => ({ at: new Date(0), again: keyed }) };
    const self = new (class Loop {
      toJSON(): this {
        return this;
      }
    })();

    expect(toStoredJson({ a: keyed, list: [keyed] })).toEqual({
      a: 'key "a"',
      list: ['key "0"'],
    });
    expect(toStoredJson(keyed)).toBe('key ""');
    expect(toStoredJson(wrapping)).toEqual({
      at: '1970-01-01T00:00:00.000Z',
      again: 'key "again"',
    });
    // One that returns the value itself: said as it is (JSON.stringify would write its fields).
    expect(notJson({ x: self }).what).toBe('a Loop whose toJSON returns itself');
    // What a toJSON returns is not asked for its own toJSON: a Decimal from one is a Decimal.
    class Decimal {
      toJSON(): string {
        return '1';
      }
    }
    expect(notJson({ x: { toJSON: () => new Decimal() } })).toMatchObject({
      path: 'x',
      what: 'a Decimal',
    });
    expect(notJson({ x: { toJSON: () => new Map() } })).toMatchObject({ path: 'x', what: 'a Map' });
    expect(notJson({ x: { toJSON: () => [undefined] } }).path).toBe('x[0]');
    // One that returns undefined: left out of an object (as JSON does), refused in an array.
    expect(toStoredJson({ a: { toJSON: () => undefined }, b: 1 })).toEqual({ b: 1 });
    expect(notJson({ list: [{ toJSON: () => undefined }] }).path).toBe('list[0]');
  });

  test('a value it produced is returned as it is: frozen, so sharing it is safe', () => {
    const copy = toStoredJson({ state: [1, 2] });

    expect(toStoredJson(copy)).toBe(copy);
    const wrapped = toStoredJson({ fold: 'log', state: copy }) as { state: unknown };
    expect(wrapped.state).toBe(copy);
  });

  test.each<[string, unknown, string, string]>([
    ['a Map', { m: new Map() }, 'm', 'a Map'],
    ['a Set', { s: new Set() }, 's', 'a Set'],
    ['an Error', { error: new Error('failed') }, 'error', 'an Error'],
    ['a class instance', { x: new (class Point {})() }, 'x', 'a Point'],
    ['an object made without a constructor name', { x: new (class {})() }, 'x', 'an object'],
    ['a bigint', { n: [1n] }, 'n[0]', 'a bigint'],
    ['NaN', { n: Number.NaN }, 'n', 'NaN'],
    ['Infinity', { list: [{ n: Number.POSITIVE_INFINITY }] }, 'list[0].n', 'Infinity'],
    ['a function', { f: () => 1 }, 'f', 'a function'],
    ['a symbol', { s: Symbol('s') }, 's', 'a symbol'],
    ['undefined in an array', { list: [1, undefined] }, 'list[1]', 'undefined'],
    ['an array hole', { list: Object.assign([1], { 2: 3 }) }, 'list[1]', 'undefined'],
    ['the root itself', new Set([1]), '', 'a Set'],
    ['a Data.struct (Effect)', { d: Data.struct({ a: 1 }) }, 'd', 'a Data value'],
    [
      'an unnamed Data.Class (Effect)',
      { d: new (class extends Data.Class<{ a: number }> {})({ a: 1 }) },
      'd',
      'a Data value',
    ],
  ])('rejects %s with its path', (_label, value, path, what) => {
    const error = notJson(value);

    expect(error).toBeInstanceOf(NotJsonCompatibleError);
    expect(error.path).toBe(path);
    expect(error.what).toBe(what);
    expect(error.message).toBe(
      `${path === '' ? 'the value' : `the value at ${path}`} is not JSON-compatible: ${what}`,
    );
  });

  test('rejects a cycle, but copies a shared (acyclic) object twice', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = { back: cyclic };
    const shared = { x: 1 };

    expect(notJson(cyclic).path).toBe('self.back');
    expect(notJson(cyclic).what).toBe('a circular reference');
    const copy = toStoredJson({ one: shared, two: shared }) as { one: unknown; two: unknown };
    expect(copy).toEqual({ one: { x: 1 }, two: { x: 1 } });
  });
});

describe('storedJsonOf', () => {
  test('is toStoredJson as an Either: the copy, or the NotJsonCompatibleError', () => {
    const right = storedJsonOf({ a: [1] });
    const left = storedJsonOf({ at: new Map() });

    expect(Either.getOrThrow(right)).toEqual({ a: [1] });
    expect(Object.isFrozen(Either.getOrThrow(right))).toBe(true);
    expect(Either.isLeft(left) && left.left).toBeInstanceOf(NotJsonCompatibleError);
  });

  test('a getter or a toJSON that throws is refused as such, at its path; the error is the cause', () => {
    const failure = new RangeError('failed');
    const getter = storedJsonOf({
      deep: {
        get broken(): never {
          throw failure;
        },
      },
    });
    const toJSON = storedJsonOf({
      at: new (class Stamp {
        toJSON(): never {
          throw failure;
        }
      })(),
    });

    expect(Either.isLeft(getter) && getter.left).toMatchObject({
      path: 'deep.broken',
      what: 'a getter that threw',
      cause: failure,
    });
    expect(Either.isLeft(toJSON) && toJSON.left).toMatchObject({
      path: 'at',
      what: 'a Stamp whose toJSON threw',
      cause: failure,
    });
  });

  test('anything else thrown while copying (a Proxy whose traps throw) is not caught', () => {
    const exotic = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new RangeError('trap failed');
        },
      },
    );

    expect(() => storedJsonOf({ exotic })).toThrow(RangeError);
  });
});

describe('storedFormOf: the stored form of an encoded payload, checked to decode again', () => {
  const at = new Date(Date.UTC(2026, 0, 2));
  const iso = '2026-01-02T00:00:00.000Z';
  const stored = (schema: S.Schema.Any | undefined, encoded: unknown) =>
    Either.getOrThrow(storedFormOf(schema, encoded));
  const refused = (schema: S.Schema.Any | undefined, encoded: unknown) => {
    const result = storedFormOf(schema, encoded);
    if (Either.isRight(result)) throw new Error('storedFormOf accepted the payload');
    return result.left;
  };

  test('a Date in an S.Unknown field (or a record of them) is stored as its ISO string', () => {
    const ToolUsed = S.Struct({ output: S.optional(S.Unknown) });
    const Row = S.Record({ key: S.String, value: S.Unknown });

    expect(stored(ToolUsed, { output: [{ id: 1, createdAt: at }] })).toEqual({
      output: [{ id: 1, createdAt: iso }],
    });
    expect(stored(Row, { createdAt: at, n: 1 })).toEqual({ createdAt: iso, n: 1 });
    expect(stored(S.Unknown, at)).toBe(iso);
  });

  test('a stored form its schema does not decode is refused, naming the value toJSON changed', () => {
    // S.DateFromSelf: the ISO string toJSON gives is no Date.
    const error = refused(S.Struct({ ok: S.Unknown, at: S.DateFromSelf }), { ok: at, at });

    expect(error).toBeInstanceOf(NotJsonCompatibleError);
    expect(error).toMatchObject({ path: 'at', what: 'a Date' });
    // Deeper: what toJSON returned is not what the schema expects there.
    class Money {
      toJSON() {
        return { cents: '100' };
      }
    }
    const Priced = S.Struct({ price: S.instanceOf(Money) });
    expect(refused(Priced, { price: new Money() })).toMatchObject({
      path: 'price',
      what: 'a Money',
    });
    // An Option under S.OptionFromSelf: its toJSON form is no Option.
    expect(
      refused(S.Struct({ o: S.OptionFromSelf(S.Number) }), { o: Option.some(1) }),
    ).toMatchObject({ path: 'o', what: 'an Option' });
    expect(
      refused(S.Struct({ e: S.EitherFromSelf({ left: S.String, right: S.Number }) }), {
        e: Either.right(1),
      }),
    ).toMatchObject({ path: 'e', what: 'an Either' });
    // A decode issue inside the value toJSON changed (here its `cents`) is about that value too.
    class Price {
      readonly cents = 100;
      toJSON() {
        return { cents: '100' };
      }
    }
    expect(
      refused(S.Struct({ price: S.Struct({ cents: S.Number }) }), { price: new Price() }),
    ).toMatchObject({ path: 'price', what: 'a Price' });
    // In an array: the item's index is in the path.
    expect(refused(S.Struct({ list: S.Array(S.DateFromSelf) }), { list: [at] })).toMatchObject({
      path: 'list[0]',
      what: 'a Date',
    });
    // A refinement over the whole payload: the issue is at the root, above the Date.
    const Dated = S.Struct({ at: S.Unknown }).pipe(S.filter((value) => value.at instanceof Date));
    expect(refused(Dated, { at })).toMatchObject({ path: 'at', what: 'a Date' });
  });

  test('an undefined property is left out: decoding reads the missing key as undefined', () => {
    const Required = S.Struct({ note: S.UndefinedOr(S.String) });
    const Optional = S.Struct({ note: S.optional(S.String) });

    expect(stored(Required, { note: undefined })).toEqual({});
    expect(Either.getOrThrow(decodeStoredPayload(Required, {}))).toEqual({ note: undefined });
    expect(stored(Optional, { note: undefined })).toEqual({});
  });

  test('a decode issue no toJSON caused is not its concern: the payload is stored', () => {
    // Never decodes, whatever is stored: as without a Date, folds skip (and report) it.
    const Broken = S.transformOrFail(S.String, S.String, {
      strict: true,
      decode: (text, _options, ast) => ParseResult.fail(new ParseResult.Type(ast, text, 'never')),
      encode: ParseResult.succeed,
    });

    expect(stored(S.Struct({ at: S.Unknown, broken: Broken }), { at, broken: 'x' })).toEqual({
      at: iso,
      broken: 'x',
    });
  });

  test('without a schema, or with nothing changed, the copy is all there is', () => {
    expect(stored(undefined, { at, gone: undefined })).toEqual({ at: iso });
    const Plain = S.Struct({ text: S.String });
    expect(stored(Plain, { text: 'hi' })).toEqual({ text: 'hi' });
    expect(refused(Plain, { text: 'hi', m: new Map() })).toMatchObject({
      path: 'm',
      what: 'a Map',
    });
  });
});

describe('isTransformingSchema', () => {
  test.each<[string, S.Schema.Any]>([
    ['a struct of primitives', S.Struct({ text: S.String, n: S.Number, ok: S.Boolean })],
    ['refinements', S.Struct({ text: S.NonEmptyString, n: S.Int.pipe(S.positive()) })],
    [
      'optional fields, arrays, tuples and records',
      S.Struct({
        a: S.optional(S.String),
        list: S.Array(S.Struct({ x: S.Literal('x') })),
        pair: S.Tuple(S.String, S.Number),
        rest: S.Tuple([S.String], S.Number),
        record: S.Record({ key: S.String, value: S.Number }),
      }),
    ],
    ['unions and literals', S.Union(S.Literal('a'), S.Struct({ kind: S.Literal('b') }), S.Null)],
    ['unknown and any', S.Struct({ u: S.Unknown, a: S.Any })],
    ['template literals and enums', S.Struct({ t: S.TemplateLiteral('id-', S.Number) })],
  ])('false for %s: decoding gives back its input', (_label, schema) => {
    expect(isTransformingSchema(schema)).toBe(false);
  });

  class Point extends S.Class<Point>('Point')({ x: S.Number }) {}

  test.each<[string, S.Schema.Any]>([
    ['NumberFromString', S.NumberFromString],
    ['Date (from a string)', S.Struct({ at: S.Date })],
    ['a nested transformation', S.Struct({ list: S.Array(S.Struct({ n: S.NumberFromString })) })],
    ['a transformation in a tuple rest', S.Tuple([S.String], S.NumberFromString)],
    ['a transformation in a tuple element', S.Tuple(S.NumberFromString)],
    ['a transformation in a record', S.Record({ key: S.String, value: S.NumberFromString })],
    ['a transformation in a union', S.Union(S.String, S.NumberFromString)],
    ['an Option', S.Option(S.String)],
    ['a class', Point],
    ['a declaration (DateFromSelf)', S.DateFromSelf],
    ['a refined transformation', S.NumberFromString.pipe(S.positive())],
    ['a default value', S.Struct({ n: S.optionalWith(S.Number, { default: () => 0 }) })],
    ['a renamed key', S.Struct({ n: S.propertySignature(S.Number).pipe(S.fromKey('N')) })],
  ])('true for %s', (_label, schema) => {
    expect(isTransformingSchema(schema)).toBe(true);
  });

  test('recursive schemas: a transformation behind a suspend is found, a cycle ends the walk', () => {
    type Tree = { readonly value: string; readonly children: ReadonlyArray<Tree> };
    const Tree: S.Schema<Tree> = S.Struct({
      value: S.String,
      children: S.Array(S.suspend(() => Tree)),
    });
    interface Counted {
      readonly n: number;
      readonly next: Counted | null;
    }
    interface CountedEncoded {
      readonly n: string;
      readonly next: CountedEncoded | null;
    }
    const Counted: S.Schema<Counted, CountedEncoded> = S.Struct({
      n: S.NumberFromString,
      next: S.NullOr(S.suspend(() => Counted)),
    });
    // The transformation after the recursion: found once the suspension was walked.
    interface Deep {
      readonly next: Deep | null;
      readonly n: number;
    }
    interface DeepEncoded {
      readonly next: DeepEncoded | null;
      readonly n: string;
    }
    const Deep: S.Schema<Deep, DeepEncoded> = S.Struct({
      next: S.NullOr(S.suspend(() => Deep)),
      n: S.NumberFromString,
    });

    // The only transformation is behind the suspension.
    const Wrapped = S.Struct({ inner: S.suspend(() => Counted) });

    expect(isTransformingSchema(Tree)).toBe(false);
    expect(isTransformingSchema(Counted)).toBe(true);
    expect(isTransformingSchema(Deep)).toBe(true);
    expect(isTransformingSchema(Wrapped)).toBe(true);
  });
});

describe('encodePayload / decodeStoredPayload', () => {
  const Payload = S.Struct({ n: S.NumberFromString, at: S.Date, tag: S.optional(S.String) });

  test('a transforming schema encodes and decodes; the round trip gives the value back', () => {
    const value = { n: 42, at: new Date('2026-01-02T03:04:05.000Z') };

    const encoded = Either.getOrThrow(encodePayload(Payload, value));
    expect(encoded).toEqual({ n: '42', at: '2026-01-02T03:04:05.000Z' });
    const decoded = Either.getOrThrow(decodeStoredPayload(Payload, toStoredJson(encoded)));
    expect(decoded).toEqual(value);
    expect((decoded as typeof value).at).toBeInstanceOf(Date);
  });

  test('a schema that does not transform: encoding is the value itself, decoding validates only', () => {
    const Plain = S.Struct({ text: S.String });
    const value = { text: 'hi' };
    const stored = toStoredJson(value);

    expect(Either.getOrThrow(encodePayload(Plain, value))).toBe(value);
    // The stored (frozen) object itself, not a decoded copy.
    expect(Either.getOrThrow(decodeStoredPayload(Plain, stored))).toBe(stored);
  });

  test('a schema that does not transform: fields it does not know are stripped (a copy)', () => {
    const Plain = S.Struct({ text: S.String, nested: S.Struct({ n: S.Number }) });
    const stored = toStoredJson({ text: 'hi', removed: 1, nested: { n: 1, old: true } });

    const decoded = Either.getOrThrow(decodeStoredPayload(Plain, stored));

    expect(decoded).toEqual({ text: 'hi', nested: { n: 1 } });
    expect(Object.keys(decoded as object)).toEqual(['text', 'nested']);
    expect(decoded).not.toBe(stored);
  });

  test('decoding is deterministic: the same stored payload always gives an equal value', () => {
    const stored = toStoredJson({ n: '7', at: '2026-01-01T00:00:00.000Z' });

    const first = Either.getOrThrow(decodeStoredPayload(Payload, stored));
    const second = Either.getOrThrow(
      decodeStoredPayload(Payload, JSON.parse(JSON.stringify(stored))),
    );
    expect(second).toEqual(first);
  });

  test('a stored payload the schema rejects is a Left with the ParseError, both kinds of schema', () => {
    const Plain = S.Struct({ text: S.String });

    const transformed = decodeStoredPayload(Payload, { n: 'not a number', at: 'x' });
    const plain = decodeStoredPayload(Plain, { text: 1 });

    expect(Either.isLeft(transformed) && transformed.left._tag).toBe('ParseError');
    expect(Either.isLeft(plain) && plain.left.message).toContain('text');
  });

  test('a value the schema cannot encode is a Left', () => {
    const encoded = encodePayload(Payload, { n: 'already a string', at: 'not a Date' });

    expect(Either.isLeft(encoded)).toBe(true);
  });

  test('an Option and a class round-trip through their JSON form', () => {
    class Point extends S.Class<Point>('Point')({ x: S.Number }) {}
    const Shape = S.Struct({ label: S.Option(S.String), point: Point });
    const value = { label: Option.some('a'), point: new Point({ x: 1 }) };

    const stored = toStoredJson(Either.getOrThrow(encodePayload(Shape, value)));
    const decoded = Either.getOrThrow(
      decodeStoredPayload(Shape, JSON.parse(JSON.stringify(stored))),
    ) as typeof value;

    expect(stored).toEqual({ label: { _tag: 'Some', value: 'a' }, point: { x: 1 } });
    expect(Option.getOrThrow(decoded.label)).toBe('a');
    expect(decoded.point).toBeInstanceOf(Point);
    expect(decoded.point.x).toBe(1);
  });
});

describe('decodeWirePayload: data from outside, which arrives in its encoded form', () => {
  const Strings = S.Struct({ b64: S.StringFromBase64, uri: S.StringFromUriComponent });
  const Numbers = S.Struct({ n: S.NumberFromString });

  test('is decoded first, also when it would pass as a value of the type (string codecs)', () => {
    expect(Either.getOrThrow(decodeWirePayload(Strings, { b64: 'aGk=', uri: 'a%20b' }))).toEqual({
      b64: 'hi',
      uri: 'a b',
    });
  });

  test('one that does not decode but is a value of the type is taken (without unknown fields)', () => {
    expect(Either.getOrThrow(decodeWirePayload(Numbers, { n: 5, extra: true }))).toEqual({ n: 5 });
  });

  test('a string that is not base64 cannot be wire data: it is taken as the decoded value', () => {
    expect(Either.getOrThrow(decodeWirePayload(Strings, { b64: '%%%', uri: 'a' }))).toEqual({
      b64: '%%%',
      uri: 'a',
    });
  });

  test('neither: a Left with the decode error', () => {
    const result = decodeWirePayload(Numbers, { n: 'five' });

    expect(Either.isLeft(result) && result.left._tag).toBe('ParseError');
    expect(Either.isLeft(decodeWirePayload(Strings, { b64: 42, uri: 'a' }))).toBe(true);
  });
});

describe('unstorableIn: where a schema encodes to something JSON cannot hold', () => {
  test.each<[string, S.Schema.Any]>([
    ['plain data', S.Struct({ a: S.String, list: S.Array(S.Number), n: S.NullOr(S.Literal(1)) })],
    ['transformations that encode to JSON', S.Struct({ at: S.Date, o: S.Option(S.String) })],
    [
      'a class (encoded as its fields)',
      S.Struct({ p: S.Class<{ x: number }>('P')({ x: S.Number }) }),
    ],
    ['unknown and any (anything may be in them)', S.Struct({ u: S.Unknown, a: S.Any })],
    [
      'Redacted (its own check: redactedIn, an error for durable events)',
      S.Struct({ r: S.RedactedFromSelf(S.String) }),
    ],
  ])('nothing for %s', (_label, schema) => {
    expect(unstorableIn(schema)).toBeUndefined();
  });

  type Tree = { readonly at: Date; readonly children: ReadonlyArray<Tree> };
  const Tree: S.Schema<Tree> = S.Struct({
    at: S.DateFromSelf,
    children: S.Array(S.suspend(() => Tree)),
  });
  type Plain = { readonly children: ReadonlyArray<Plain> };
  const Plain: S.Schema<Plain> = S.Struct({ children: S.Array(S.suspend(() => Plain)) });

  test.each<[string, S.Schema.Any, { path: string; what: string }]>([
    ['a declaration', S.Struct({ at: S.DateFromSelf }), { path: 'at', what: 'DateFromSelf' }],
    ['instanceOf', S.Struct({ m: S.instanceOf(Map) }), { path: 'm', what: 'Map' }],
    [
      'a declaration with type parameters',
      S.Struct({ o: S.OptionFromSelf(S.String) }),
      { path: 'o', what: 'Option<string>' },
    ],
    ['a bigint', S.Struct({ n: S.BigIntFromSelf }), { path: 'n', what: 'bigint' }],
    ['a bigint literal', S.Struct({ n: S.Literal(1n) }), { path: 'n', what: 'bigint' }],
    ['a symbol', S.Struct({ s: S.SymbolFromSelf }), { path: 's', what: 'symbol' }],
    [
      'a unique symbol',
      S.Struct({ s: S.UniqueSymbolFromSelf(Symbol.for('x')) }),
      { path: 's', what: 'symbol' },
    ],
    [
      'a refinement of one',
      S.Struct({ at: S.DateFromSelf.pipe(S.validDate()) }),
      { path: 'at', what: 'DateFromSelf' },
    ],
    ['a tuple element', S.Tuple(S.String, S.DateFromSelf), { path: '[1]', what: 'DateFromSelf' }],
    [
      'array items',
      S.Struct({ list: S.Array(S.DateFromSelf) }),
      { path: 'list[*]', what: 'DateFromSelf' },
    ],
    [
      'record values',
      S.Record({ key: S.String, value: S.DateFromSelf }),
      { path: '[*]', what: 'DateFromSelf' },
    ],
    ['a union member', S.Union(S.String, S.DateFromSelf), { path: '', what: 'DateFromSelf' }],
    ['behind a suspension', Tree, { path: 'at', what: 'DateFromSelf' }],
    [
      'a transformation from one',
      S.transform(S.DateFromSelf, S.String, {
        strict: true,
        decode: String,
        encode: (s) => new Date(s),
      }),
      { path: '', what: 'DateFromSelf' },
    ],
  ])('finds %s', (_label, schema, found) => {
    expect(unstorableIn(schema)).toEqual(found);
  });

  test('a recursive schema without one is walked once and ends', () => {
    expect(unstorableIn(Plain)).toBeUndefined();
  });
});

describe('redactedIn: where a schema holds S.Redacted', () => {
  class Login extends S.Class<Login>('Login')({ password: S.Redacted(S.String) }) {}
  type Tree = { readonly children: ReadonlyArray<Tree>; readonly key?: Redacted.Redacted<string> };
  const Tree: S.Schema<Tree, unknown> = S.Struct({
    children: S.Array(S.suspend((): S.Schema<Tree, unknown> => Tree)),
    key: S.optional(S.Redacted(S.String)),
  }) as never;
  type Plain = { readonly children: ReadonlyArray<Plain> };
  const Plain: S.Schema<Plain> = S.Struct({ children: S.Array(S.suspend(() => Plain)) });

  test.each<[string, S.Schema.Any, string]>([
    ['the payload itself', S.Redacted(S.String), ''],
    ['RedactedFromSelf', S.Struct({ key: S.RedactedFromSelf(S.String) }), 'key'],
    [
      'a nested field',
      S.Struct({ creds: S.Struct({ password: S.Redacted(S.String) }) }),
      'creds.password',
    ],
    ['an optional field', S.Struct({ token: S.optional(S.Redacted(S.String)) }), 'token'],
    ['a union member', S.Struct({ key: S.Union(S.Null, S.Redacted(S.String)) }), 'key'],
    ['array items', S.Struct({ keys: S.Array(S.Redacted(S.Number)) }), 'keys[*]'],
    ['a tuple element', S.Tuple(S.String, S.Redacted(S.String)), '[1]'],
    ['record values', S.Record({ key: S.String, value: S.Redacted(S.String) }), '[*]'],
    [
      'a refinement of one',
      S.Struct({ pin: S.Redacted(S.String).pipe(S.filter(() => true)) }),
      'pin',
    ],
    ['behind a suspension', S.Struct({ inner: S.suspend(() => S.Redacted(S.String)) }), 'inner'],
    // Depth first: the first place found, here inside the first child.
    ['a recursive schema', Tree, 'children[*].key'],
    ['a class field', S.Struct({ login: Login }), 'login.password'],
    ['an Option', S.Struct({ key: S.Option(S.Redacted(S.String)) }), 'key.value'],
    [
      'a declaration parameter',
      S.Struct({ key: S.OptionFromSelf(S.RedactedFromSelf(S.String)) }),
      'key',
    ],
    [
      'the decoded side of a transformation only',
      S.transform(S.String, S.Struct({ key: S.RedactedFromSelf(S.String) }), {
        strict: true,
        decode: (key) => ({ key: Redacted.make(key) }),
        encode: ({ key }) => Redacted.value(key),
      }),
      'key',
    ],
  ])('finds %s', (_label, schema, path) => {
    expect(redactedIn(schema)).toEqual({ path });
  });

  test.each<[string, S.Schema.Any]>([
    ['plain data', S.Struct({ a: S.String, list: S.Array(S.Number) })],
    [
      'transformations and declarations',
      S.Struct({ at: S.Date, raw: S.DateFromSelf, o: S.Option(S.String) }),
    ],
    ['unknown (whatever it holds at runtime)', S.Struct({ u: S.Unknown })],
    ['a recursive schema without it', Plain],
  ])('nothing in %s', (_label, schema) => {
    expect(redactedIn(schema)).toBeUndefined();
  });
});

describe('encodeForWire: as encodePayload, with Redacted values sent as "<redacted>"', () => {
  class Login extends S.Class<Login>('Login')({
    password: S.Redacted(S.String),
    n: S.NumberFromString,
  }) {}
  const secret = Redacted.make('hunter2');
  const wire = (schema: S.Schema.Any, value: unknown) =>
    Either.getOrThrow(encodeForWire(schema, value));

  test('a schema without Redacted is encoded as it is: wireSchemaOf is the schema itself', () => {
    const Measured = S.Struct({ n: S.NumberFromString });

    expect(wireSchemaOf(Measured)).toBe(Measured);
    expect(wire(Measured, { n: 2 })).toEqual({ n: '2' });
  });

  test.each<[string, S.Schema.Any, unknown, unknown]>([
    ['the payload itself', S.Redacted(S.String), secret, '<redacted>'],
    [
      'next to other encoded fields',
      S.Struct({ key: S.Redacted(S.String), n: S.NumberFromString }),
      { key: secret, n: 5 },
      { key: '<redacted>', n: '5' },
    ],
    [
      'RedactedFromSelf',
      S.Struct({ key: S.RedactedFromSelf(S.String) }),
      { key: secret },
      { key: '<redacted>' },
    ],
    ['a Redacted number', S.Redacted(S.NumberFromString), Redacted.make(4), '<redacted>'],
    [
      'an optional field',
      S.Struct({ key: S.optional(S.Redacted(S.String)) }),
      { key: secret },
      { key: '<redacted>' },
    ],
    [
      'a default',
      S.Struct({ key: S.optionalWith(S.Redacted(S.String), { default: () => secret }) }),
      { key: secret },
      { key: '<redacted>' },
    ],
    [
      'a union member',
      S.Struct({ key: S.Union(S.Number, S.Redacted(S.String)) }),
      { key: secret },
      { key: '<redacted>' },
    ],
    ['array items', S.Array(S.Redacted(S.String)), [secret], ['<redacted>']],
    [
      'a tuple element',
      S.Tuple(S.String, S.Redacted(S.String)),
      ['a', secret],
      ['a', '<redacted>'],
    ],
    [
      'record values',
      S.Record({ key: S.String, value: S.Redacted(S.String) }),
      { a: secret },
      { a: '<redacted>' },
    ],
    ['a refinement', S.Redacted(S.String).pipe(S.filter(() => true)), secret, '<redacted>'],
    ['a class', Login, new Login({ password: secret, n: 3 }), { password: '<redacted>', n: '3' }],
    [
      'an Option',
      S.Struct({ key: S.Option(S.Redacted(S.String)) }),
      { key: Option.some(secret) },
      { key: { _tag: 'Some', value: '<redacted>' } },
    ],
    [
      'a declaration parameter',
      S.OptionFromSelf(S.RedactedFromSelf(S.String)),
      Option.some(secret),
      Option.some('<redacted>'),
    ],
    [
      'behind a suspension',
      S.Struct({ inner: S.suspend(() => S.Redacted(S.String)) }),
      { inner: secret },
      { inner: '<redacted>' },
    ],
    [
      'a transformation with it on its decoded side only: all of the value',
      S.transform(S.String, S.Struct({ key: S.RedactedFromSelf(S.String) }), {
        strict: true,
        decode: (key) => ({ key: Redacted.make(key) }),
        encode: ({ key }) => Redacted.value(key),
      }),
      { key: secret },
      '<redacted>',
    ],
  ])('%s', (_label, schema, value, sent) => {
    expect(wire(schema, value)).toEqual(sent);
    expect(JSON.stringify(wire(schema, value))).not.toContain('hunter2');
  });

  test('a recursive schema is rebuilt once and encodes at every depth', () => {
    type Node = { readonly key: Redacted.Redacted<string>; readonly next: Node | null };
    const Node: S.Schema<Node, unknown> = S.Struct({
      key: S.Redacted(S.String),
      next: S.NullOr(S.suspend((): S.Schema<Node, unknown> => Node)),
    }) as never;

    expect(wire(Node, { key: secret, next: { key: secret, next: null } })).toEqual({
      key: '<redacted>',
      next: { key: '<redacted>', next: null },
    });
    expect(wireSchemaOf(Node)).toBe(wireSchemaOf(Node));
  });

  test('the wire schema only encodes: "<redacted>" never decodes back into a secret', () => {
    const Key = S.Struct({ key: S.Redacted(S.String) });

    expect(
      Either.isLeft(S.decodeUnknownEither(wireSchemaOf(Key) as typeof Key)({ key: '<redacted>' })),
    ).toBe(true);
  });
});

describe('exports', () => {
  test('the stored-payload helpers and wireEnvelope are internal', () => {
    for (const entry of [root, matrix]) {
      for (const internal of [
        'toStoredJson',
        'storedJsonOf',
        'storedFormOf',
        'NotJsonCompatibleError',
        'isTransformingSchema',
        'encodePayload',
        'decodeStoredPayload',
        'decodeWirePayload',
        'unstorableIn',
        'redactedIn',
        'encodeForWire',
        'wireSchemaOf',
        'wirePayloadOf',
        'isMadeEvent',
        'preparePublish',
        'wireEnvelope',
        'fromWireEnvelope',
      ]) {
        expect(entry).not.toHaveProperty(internal);
      }
    }
  });
});
