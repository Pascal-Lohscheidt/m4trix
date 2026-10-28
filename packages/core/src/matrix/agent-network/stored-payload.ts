import { Either, Equal, Option, ParseResult, Schema as S, SchemaAST as AST } from 'effect';
import type { ParseOptions } from 'effect/SchemaAST';

/**
 * What the store holds: the runtime appends each durable event as a deep-frozen JSON copy, its
 * payload encoded with its event's schema; folds decode it again on read. This file holds the
 * JSON copy and the schema codec both sides use.
 */

/**
 * @internal `toStoredJson` was given a value JSON cannot represent as it is: `what` there is at
 * `path` (`user.id`, `tags[1]`; `''` is the root). `cause`: what a getter or a `toJSON` threw.
 */
export class NotJsonCompatibleError extends Error {
  readonly _tag = 'NotJsonCompatibleError' as const;

  constructor(
    readonly path: string,
    readonly what: string,
    readonly cause?: unknown,
  ) {
    super(`${path === '' ? 'the value' : `the value at ${path}`} is not JSON-compatible: ${what}`);
    this.name = 'NotJsonCompatibleError';
  }
}

/**
 * An event published from outside the network (`plane.publish`, `publishToChannels`,
 * `publishAndAwait`, a proxy's `publish` / `withMeta(...).publish` / `publishInbound`) carries a
 * payload the store cannot keep: durable events are stored as JSON, encoded with their event's
 * schema, and JSON cannot hold `found` at `path` (an instance of a class without a `toJSON`, such
 * as a `Map`, `Set` or `Error`; a `bigint`; a value whose `toJSON` form its schema does not read
 * back, such as a `Date` under `S.DateFromSelf`). Nothing was published: no agent saw it, nothing
 * was stored, and its run goes on. `expose()` answers such a start event with a 400.
 */
export class NonJsonPayloadError extends Error {
  /** Discriminant for `catch` / Effect error handling. */
  readonly _tag = 'NonJsonPayloadError' as const;

  constructor(
    /** The event that was not published. */
    readonly eventName: string,
    /** Where in the payload: `user.id`, `tags[1]`; `''` is the payload itself. */
    readonly path: string,
    /** What JSON cannot hold there, e.g. `a Map` or `a bigint` (never the value itself). */
    readonly found: string,
  ) {
    super(
      `Published ${JSON.stringify(eventName)} with a payload that is not JSON-compatible: ` +
        `${found} at ${path === '' ? '(root)' : path} (events are stored as JSON, encoded with ` +
        'their schema); nothing was published',
    );
    this.name = 'NonJsonPayloadError';
  }
}

/** Every object `toStoredJson` produced: deep-frozen JSON, safe to share as it is. */
const storedJsonObjects = new WeakSet<object>();

const pathOf = (parent: string, key: string | number): string =>
  typeof key === 'number' ? `${parent}[${key}]` : parent === '' ? key : `${parent}.${key}`;

/**
 * `a Date`, `an Error`, `a Point`, `an Option`: an object JSON would not keep as it is, by its
 * class; `a Data value` for Effect's `Data.struct` and unnamed `Data.Class` values, `an object`
 * for a plain one (or one without a name).
 */
function describeObject(value: object): string {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype === Object.prototype || prototype === null) return 'an object';
  if (Option.isOption(value)) return 'an Option';
  if (Either.isEither(value)) return 'an Either';
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  if (typeof name === 'string' && name !== '' && name !== 'Object') {
    return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
  }
  return Equal.isEqual(value) ? 'a Data value' : 'an object';
}

/** A value the copy turned into something else by calling its `toJSON` (`what`: e.g. `a Date`). */
type Converted = { readonly path: string; readonly what: string };

/**
 * The JSON copy of `value` (at `path`, under `key` in its parent, as `JSON.stringify` passes it to
 * `toJSON`); each value it changed is added to `converted`. `callToJSON` is false for what a
 * `toJSON` returned: like `JSON.stringify`, the copy asks each value once.
 */
function copy(
  value: unknown,
  path: string,
  key: string,
  ancestors: Set<object>,
  converted: Converted[],
  callToJSON = true,
): unknown {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new NotJsonCompatibleError(path, String(value));
      return value;
    case 'object': {
      if (value === null || storedJsonObjects.has(value)) return value;
      if (ancestors.has(value)) throw new NotJsonCompatibleError(path, 'a circular reference');
      const toJSON = callToJSON && (value as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function') {
        // As JSON.stringify: a Date becomes its ISO string, a Decimal its own form.
        const what = describeObject(value);
        converted.push({ path, what });
        let returned: unknown;
        try {
          returned = toJSON.call(value, key);
        } catch (error) {
          throw new NotJsonCompatibleError(path, `${what} whose toJSON threw`, error);
        }
        // JSON.stringify would write its fields; the copy does not guess what those are worth.
        if (returned === value) {
          throw new NotJsonCompatibleError(path, `${what} whose toJSON returns itself`);
        }
        ancestors.add(value);
        const json = copy(returned, path, key, ancestors, converted, false);
        ancestors.delete(value);
        return json;
      }
      const prototype = Object.getPrototypeOf(value) as unknown;
      const isArray = Array.isArray(value) && prototype === Array.prototype;
      if (!isArray && prototype !== Object.prototype && prototype !== null) {
        throw new NotJsonCompatibleError(path, describeObject(value));
      }
      ancestors.add(value);
      let result: object;
      if (isArray) {
        const list = value as readonly unknown[];
        const items: unknown[] = [];
        for (let index = 0; index < list.length; index++) {
          const at = pathOf(path, index);
          const item = copy(list[index], at, String(index), ancestors, converted);
          if (item === undefined) throw new NotJsonCompatibleError(at, 'undefined');
          items.push(item);
        }
        result = items;
      } else {
        // `Object.fromEntries` defines properties: a `__proto__` key stays data, as in JSON.parse.
        const entries: Array<[string, unknown]> = [];
        for (const name of Object.keys(value)) {
          const at = pathOf(path, name);
          let field: unknown;
          try {
            field = (value as Record<string, unknown>)[name];
          } catch (error) {
            throw new NotJsonCompatibleError(at, 'a getter that threw', error);
          }
          // As JSON.stringify: an undefined property (e.g. an absent optional field) is left out,
          // also one a toJSON returned. Decoding reads a missing key as undefined.
          const json = field === undefined ? field : copy(field, at, name, ancestors, converted);
          if (json !== undefined) entries.push([name, json]);
        }
        result = Object.fromEntries(entries);
      }
      ancestors.delete(value);
      Object.freeze(result);
      storedJsonObjects.add(result);
      return result;
    }
    case 'undefined':
      // Only at the root: a missing payload (a property of the stored event JSON leaves out).
      return value;
    case 'bigint':
      throw new NotJsonCompatibleError(path, 'a bigint');
    case 'symbol':
      throw new NotJsonCompatibleError(path, 'a symbol');
    default:
      throw new NotJsonCompatibleError(path, 'a function');
  }
}

/** `copy` from the root: the JSON copy, and the values whose `toJSON` it called. */
function copyToJson(value: unknown): { readonly json: unknown; readonly converted: Converted[] } {
  const converted: Converted[] = [];
  return { json: copy(value, '', '', new Set(), converted), converted };
}

/**
 * @internal A deep-frozen copy of `value` as JSON represents it: what `JSON.parse(JSON.stringify(
 * value))` gives (`toJSON` called, so a `Date` is its ISO string; undefined properties left out;
 * a `__proto__` key kept as data), without sharing an object with `value`. Throws
 * `NotJsonCompatibleError` for what JSON cannot represent as it is: instances of classes without
 * a `toJSON` (`Map`, `Set`, `Error`, ...), bigints, functions, symbols, non-finite numbers,
 * `undefined` in arrays, cycles, a getter or a `toJSON` that throws (the error is its `cause`). A
 * value it produced itself is returned as it is (it is frozen).
 */
export function toStoredJson(value: unknown): unknown {
  return copyToJson(value).json;
}

/** `fn()`, with a `NotJsonCompatibleError` it throws as a Left; anything else is thrown. */
function notJsonAsLeft<A>(fn: () => A): Either.Either<A, NotJsonCompatibleError> {
  try {
    return Either.right(fn());
  } catch (error) {
    if (error instanceof NotJsonCompatibleError) return Either.left(error);
    throw error;
  }
}

/**
 * @internal `toStoredJson(value)` as an Either: the copy, or the `NotJsonCompatibleError` for a
 * value JSON cannot represent. Anything else thrown while copying (a `Proxy` whose traps throw)
 * is thrown.
 */
export function storedJsonOf(value: unknown): Either.Either<unknown, NotJsonCompatibleError> {
  return notJsonAsLeft(() => toStoredJson(value));
}

/** True when the value at path `inner` is the one at `outer` or part of it. */
const within = (inner: string, outer: string): boolean =>
  outer === '' || inner === outer || inner.startsWith(`${outer}.`) || inner.startsWith(`${outer}[`);

/**
 * @internal The stored form of `encoded`, a payload (or state) encoded with `schema`: its JSON
 * copy (see `toStoredJson`). The copy calls `toJSON` where a value has one, as JSON does (a
 * `Date` becomes its ISO string); when it called any, the copy is decoded with `schema` again, so
 * nothing is stored that reads back as something else: a decode issue about such a value (e.g. a
 * `Date` under `S.DateFromSelf`, which an ISO string is not) is a Left `NotJsonCompatibleError`
 * naming it and its path. Without `schema`, or for issues no `toJSON` caused (the payload would
 * not decode anyway; folds skip it), the copy. A Left too for what JSON cannot hold at all (see
 * `toStoredJson`); anything else thrown is thrown. Leaving undefined properties out needs no
 * check: decoding reads a missing key as undefined.
 */
export function storedFormOf(
  schema: S.Schema.Any | undefined,
  encoded: unknown,
): Either.Either<unknown, NotJsonCompatibleError> {
  return Either.flatMap(
    notJsonAsLeft(() => copyToJson(encoded)),
    ({ json, converted }) => {
      if (!schema || converted.length === 0) return Either.right(json);
      const decoded = decodeStoredPayload(schema, json, { errors: 'all' });
      if (Either.isRight(decoded)) return Either.right(json);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(decoded.left).map((issue) =>
        issue.path.reduce<string>(
          (at, key) => pathOf(at, typeof key === 'number' ? key : String(key)),
          '',
        ),
      );
      const broken = converted.find(({ path }) =>
        issues.some((issue) => within(issue, path) || within(path, issue)),
      );
      return broken
        ? Either.left(new NotJsonCompatibleError(broken.path, broken.what))
        : Either.right(json);
    },
  );
}

/* ─── Schema codec ─── */

/** Whether decoding with the schema of `ast` may give something else than its input. */
function transforms(ast: AST.AST, suspended: Set<AST.AST>): boolean {
  switch (ast._tag) {
    // Transformations (`NumberFromString`, `Date`, classes, `optionalWith` defaults, renamed
    // keys) change the value; declarations (`DateFromSelf`, `OptionFromSelf`) run their own
    // decoder. Every other node only checks its input and copies what its children decode to.
    case 'Transformation':
    case 'Declaration':
      return true;
    case 'Refinement':
      return transforms(ast.from, suspended);
    case 'TupleType':
      return (
        ast.elements.some((element) => transforms(element.type, suspended)) ||
        ast.rest.some((rest) => transforms(rest.type, suspended))
      );
    case 'TypeLiteral':
      return (
        ast.propertySignatures.some((property) => transforms(property.type, suspended)) ||
        ast.indexSignatures.some((index) => transforms(index.type, suspended))
      );
    case 'Union':
      return ast.types.some((type) => transforms(type, suspended));
    case 'Suspend':
      // A recursive schema: each suspension is walked once.
      if (suspended.has(ast)) return false;
      suspended.add(ast);
      return transforms(ast.f(), suspended);
    default:
      return false;
  }
}

type Codec = {
  readonly transforming: boolean;
  /** True for a value of the schema's type without fields the schema does not know. */
  readonly isExact: (u: unknown) => boolean;
  readonly decode: (
    u: unknown,
    options?: ParseOptions,
  ) => Either.Either<unknown, ParseResult.ParseError>;
  readonly encode: (u: unknown) => Either.Either<unknown, ParseResult.ParseError>;
  /** Checks a value of the schema's type (its unknown fields dropped). */
  readonly validate: (u: unknown) => Either.Either<unknown, ParseResult.ParseError>;
};

/** The compiled codec of each schema, made on first use. */
const codecs = new WeakMap<S.Schema.Any, Codec>();

function codecOf(schema: S.Schema.Any): Codec {
  let codec = codecs.get(schema);
  if (!codec) {
    const typed = schema as S.Schema<unknown, unknown, never>;
    codec = {
      transforming: transforms(schema.ast, new Set()),
      isExact: S.is(typed, { onExcessProperty: 'error' }),
      decode: S.decodeUnknownEither(typed),
      encode: S.encodeUnknownEither(typed),
      validate: S.validateEither(typed),
    };
    codecs.set(schema, codec);
  }
  return codec;
}

/**
 * @internal True when decoding with `schema` may give something else than its input: it has a
 * transformation or a declaration somewhere (see `transforms`). For any other schema the encoded
 * and the decoded form of a value are the same, so the runtime neither encodes nor rebuilds it.
 */
export function isTransformingSchema(schema: S.Schema.Any): boolean {
  return codecOf(schema).transforming;
}

/**
 * @internal `value` encoded with `schema`; the value itself for a schema that does not transform
 * (see `isTransformingSchema`). A Left when `schema` cannot encode it.
 */
export function encodePayload(
  schema: S.Schema.Any,
  value: unknown,
): Either.Either<unknown, ParseResult.ParseError> {
  const codec = codecOf(schema);
  return codec.transforming ? codec.encode(value) : Either.right(value);
}

/**
 * @internal A stored (encoded) payload decoded with `schema`. For a schema that does not
 * transform, a payload that is exactly of its type is returned as it is (stored payloads are
 * frozen, so sharing it is safe); otherwise it is decoded into a new value. Decoding strips the
 * fields the schema does not know, e.g. one removed from the schema since the event was stored,
 * so the value never carries more than its type: a fold that keeps it can still be compacted
 * (checkpoints encode strictly). Deterministic: the same stored payload always decodes to an equal
 * value. A Left (the `ParseError`) when `schema` rejects it, e.g. a field it now requires.
 */
export function decodeStoredPayload(
  schema: S.Schema.Any,
  stored: unknown,
  options?: ParseOptions,
): Either.Either<unknown, ParseResult.ParseError> {
  const codec = codecOf(schema);
  if (codec.transforming || !codec.isExact(stored)) return codec.decode(stored, options);
  return Either.right(stored);
}

/**
 * @internal A payload that arrived from outside (a proxy's publish, a request body): wire data, in
 * the encoded form the network sends, so it is decoded like a stored payload, whatever it looks
 * like. That settles string-to-string codecs (`S.StringFromBase64`, `S.parseJson(S.String)`,
 * `S.StringFromUriComponent`), where any string is both an encoded and a decoded value: `"aGk="`
 * is base64 for `"hi"`. Only a payload that does not decode but already is a value of the
 * schema's type (e.g. a number sent for `S.NumberFromString`, which no encoded value can be) is
 * taken as it is, without fields the schema does not know. A Left with the decode error otherwise
 * (`options`, e.g. `{ errors: 'all' }`, apply to the decode).
 */
export function decodeWirePayload(
  schema: S.Schema.Any,
  payload: unknown,
  options?: ParseOptions,
): Either.Either<unknown, ParseResult.ParseError> {
  const decoded = decodeStoredPayload(schema, payload, options);
  if (Either.isRight(decoded)) return decoded;
  return Either.orElse(codecOf(schema).validate(payload), () => decoded);
}

/* ─── Walking a schema ─── */

/**
 * What `findIn` sees at a node: what it found there, or the parts to look into next (`[]`:
 * none); `undefined` for the node's structure (see `structureOf`).
 */
type Look<T> =
  | { readonly found: T }
  | { readonly parts: ReadonlyArray<readonly [AST.AST, string]> }
  | undefined;

/**
 * The parts a value of `ast` (at `path`) is made of, with their paths (`[*]` any item). Each
 * suspension (a recursive schema) is walked once.
 */
function structureOf(
  ast: AST.AST,
  path: string,
  suspended: Set<AST.AST>,
): ReadonlyArray<readonly [AST.AST, string]> {
  switch (ast._tag) {
    case 'Refinement':
      return [[ast.from, path]];
    case 'TupleType':
      return [
        ...ast.elements.map((element, index) => [element.type, pathOf(path, index)] as const),
        ...ast.rest.map((rest) => [rest.type, `${path}[*]`] as const),
      ];
    case 'TypeLiteral':
      return [
        ...ast.propertySignatures.map(
          (property) => [property.type, pathOf(path, String(property.name))] as const,
        ),
        ...ast.indexSignatures.map((index) => [index.type, `${path}[*]`] as const),
      ];
    case 'Union':
      return ast.types.map((type) => [type, path] as const);
    case 'Suspend':
      if (suspended.has(ast)) return [];
      suspended.add(ast);
      return [[ast.f(), path]];
    default:
      return [];
  }
}

/** The first thing `look` finds in `ast` (at `path`), depth first. */
function findIn<T>(
  ast: AST.AST,
  path: string,
  look: (ast: AST.AST, path: string) => Look<T>,
  suspended: Set<AST.AST>,
): T | undefined {
  const step = look(ast, path) ?? { parts: structureOf(ast, path, suspended) };
  if ('found' in step) return step.found;
  for (const [part, at] of step.parts) {
    const found = findIn(part, at, look, suspended);
    if (found !== undefined) return found;
  }
  return undefined;
}

/* ─── Unstorable schemas ─── */

/** True for a Redacted declaration: `S.RedactedFromSelf`, the decoded side of `S.Redacted`. */
const isRedacted = (ast: AST.AST): boolean =>
  ast._tag === 'Declaration' &&
  (ast.annotations[AST.TypeConstructorAnnotationId] as { _tag?: unknown } | undefined)?._tag ===
    'effect/Redacted';

type Unstorable = { readonly path: string; readonly what: string };

/** What in the encoded side of a schema JSON cannot hold. */
const lookUnstorable = (ast: AST.AST, path: string): Look<Unstorable> => {
  switch (ast._tag) {
    case 'Transformation':
      // What is stored is the encoded side.
      return { parts: [[ast.from, path]] };
    case 'Declaration':
      // Redacted has a check of its own (an error at setup for durable events: `redactedIn`).
      return isRedacted(ast) ? { parts: [] } : { found: { path, what: String(ast) } };
    case 'BigIntKeyword':
      return { found: { path, what: 'bigint' } };
    case 'SymbolKeyword':
    case 'UniqueSymbol':
      return { found: { path, what: 'symbol' } };
    case 'Literal':
      return typeof ast.literal === 'bigint' ? { found: { path, what: 'bigint' } } : undefined;
    default:
      return undefined;
  }
};

/**
 * @internal Where the encoded form of `schema` holds something JSON cannot (a declaration such as
 * `S.DateFromSelf` or `S.instanceOf(...)`, a bigint, a symbol), so a payload with a value there
 * can never be stored: the first such place (`path`, `''` the root, `[*]` any item) and what it
 * is; `undefined` when there is none. Redacted values are left out: see `redactedIn`.
 */
export function unstorableIn(schema: S.Schema.Any): Unstorable | undefined {
  return findIn(schema.ast, '', lookUnstorable, new Set());
}

/* ─── Redacted ─── */

/** A Redacted value anywhere in a schema: both sides of transformations, declarations' parameters. */
const lookRedacted = (ast: AST.AST, path: string): Look<{ readonly path: string }> => {
  switch (ast._tag) {
    case 'Declaration':
      if (isRedacted(ast)) return { found: { path } };
      return { parts: ast.typeParameters.map((parameter) => [parameter, path] as const) };
    case 'Transformation':
      return {
        parts: [
          [ast.from, path],
          [ast.to, path],
        ],
      };
    default:
      return undefined;
  }
};

/**
 * @internal Where `schema` holds an `S.Redacted` (or `S.RedactedFromSelf`) value, anywhere: nested,
 * optional, in a union member, a class, an `Option`, behind a suspension. The first such place
 * (`path`, `''` the root, `[*]` any item); `undefined` when there is none. Its encoded form is the
 * secret in clear, so the wiring check refuses it in durable events (`durable-event-redacted`).
 */
export function redactedIn(schema: S.Schema.Any): { readonly path: string } | undefined {
  return findIn(schema.ast, '', lookRedacted, new Set());
}

/** What a Redacted value is sent as: what `JSON.stringify` writes for one, never the secret. */
const REDACTED_ON_THE_WIRE = '<redacted>';

/** `to` (a value holding a secret) encoded as `"<redacted>"`; it never decodes back. */
const sentRedacted = (to: AST.AST): AST.AST =>
  new AST.Transformation(
    new AST.Literal(REDACTED_ON_THE_WIRE),
    to,
    new AST.FinalTransformation(
      (input, _options, self) =>
        ParseResult.fail(new ParseResult.Forbidden(self, input, 'a redacted value never decodes')),
      () => ParseResult.succeed(REDACTED_ON_THE_WIRE),
    ),
  );

/**
 * `ast` with each Redacted value encoding to `"<redacted>"`: nodes on the way to one are rebuilt
 * (once each: `rebuilt`), the rest is shared.
 */
function redactedForWire(ast: AST.AST, rebuilt: Map<AST.AST, AST.AST>): AST.AST {
  const done = rebuilt.get(ast);
  if (done) return done;
  if (findIn(ast, '', lookRedacted, new Set()) === undefined) return ast;
  const again = (part: AST.AST): AST.AST => redactedForWire(part, rebuilt);
  let result: AST.AST;
  switch (ast._tag) {
    case 'Declaration':
      result = isRedacted(ast)
        ? sentRedacted(ast)
        : new AST.Declaration(
            ast.typeParameters.map(again),
            ast.decodeUnknown,
            ast.encodeUnknown,
            ast.annotations,
          );
      break;
    case 'Transformation':
      // `S.Redacted`, or a transformation that holds one on its decoded side only (its encode
      // could write the secret anywhere): all of the value is sent as "<redacted>".
      result =
        isRedacted(ast.to) || findIn(ast.from, '', lookRedacted, new Set()) === undefined
          ? sentRedacted(ast.to)
          : new AST.Transformation(again(ast.from), ast.to, ast.transformation, ast.annotations);
      break;
    case 'Refinement':
      result = new AST.Refinement(again(ast.from), ast.filter, ast.annotations);
      break;
    case 'TupleType':
      result = new AST.TupleType(
        ast.elements.map(
          (element) =>
            new AST.OptionalType(again(element.type), element.isOptional, element.annotations),
        ),
        ast.rest.map((rest) => new AST.Type(again(rest.type), rest.annotations)),
        ast.isReadonly,
        ast.annotations,
      );
      break;
    case 'TypeLiteral':
      result = new AST.TypeLiteral(
        ast.propertySignatures.map(
          (property) =>
            new AST.PropertySignature(
              property.name,
              again(property.type),
              property.isOptional,
              property.isReadonly,
              property.annotations,
            ),
        ),
        ast.indexSignatures.map(
          (index) => new AST.IndexSignature(index.parameter, again(index.type), index.isReadonly),
        ),
        ast.annotations,
      );
      break;
    case 'Union':
      result = AST.Union.make(ast.types.map(again), ast.annotations);
      break;
    default: {
      // A suspension: the only other node a Redacted value can be found behind.
      const suspended = ast as AST.Suspend;
      result = new AST.Suspend(() => again(suspended.f()), suspended.annotations);
    }
  }
  rebuilt.set(ast, result);
  return result;
}

/** The wire schema of each schema, made on first use. */
const wireSchemas = new WeakMap<S.Schema.Any, S.Schema.Any>();

/**
 * @internal `schema` as events are sent with it: each Redacted value it holds encodes to
 * `"<redacted>"` instead of the secret (what `S.Redacted` encodes to), so a transient event may
 * carry a secret on the stream without giving it away. The schema itself when it holds none.
 */
export function wireSchemaOf(schema: S.Schema.Any): S.Schema.Any {
  let wire = wireSchemas.get(schema);
  if (!wire) {
    const ast = redactedForWire(schema.ast, new Map());
    wire = ast === schema.ast ? schema : S.make(ast);
    wireSchemas.set(schema, wire);
  }
  return wire;
}

/**
 * @internal `value` encoded with `schema` for the wire (see `encodePayload`), its Redacted values
 * as `"<redacted>"` (see `wireSchemaOf`). A Left when `schema` cannot encode it.
 */
export function encodeForWire(
  schema: S.Schema.Any,
  value: unknown,
): Either.Either<unknown, ParseResult.ParseError> {
  return encodePayload(wireSchemaOf(schema), value);
}

/**
 * @internal The payload `value` (of an event not stored, e.g. transient) as it is sent: encoded
 * for the wire (see `encodeForWire`). One its schema cannot encode is sent as it is, unless the
 * schema holds a Redacted value: which part of the payload holds the secret is unknown then, so
 * all of it is sent as `"<redacted>"` (failing closed).
 */
export function wirePayloadOf(schema: S.Schema.Any, value: unknown): unknown {
  const encoded = encodeForWire(schema, value);
  if (Either.isRight(encoded)) return encoded.right;
  return wireSchemaOf(schema) === schema ? value : REDACTED_ON_THE_WIRE;
}
