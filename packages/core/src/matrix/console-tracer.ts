import { Context, Exit, Layer, Option, Tracer } from 'effect';

const randomHexString = (length: number): string => {
  const chars = 'abcdef0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

/** Span that logs to console when ended */
class ConsoleSpan implements Tracer.Span {
  readonly _tag = 'Span' as const;
  readonly spanId: string;
  readonly traceId: string;
  readonly sampled = true;
  status: Tracer.SpanStatus;
  attributes: Map<string, unknown> = new Map();
  links: Tracer.SpanLink[] = [];

  constructor(
    readonly name: string,
    readonly parent: Option.Option<Tracer.AnySpan>,
    readonly context: Context.Context<never>,
    links: Iterable<Tracer.SpanLink>,
    readonly startTime: bigint,
    readonly kind: Tracer.SpanKind,
    private readonly depth: number,
  ) {
    this.traceId =
      parent._tag === 'Some' ? parent.value.traceId : randomHexString(32);
    this.spanId = randomHexString(16);
    this.links = Array.from(links);
    this.status = { _tag: 'Started', startTime };
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.status._tag === 'Ended') return;
    const startTime = this.status.startTime;
    const durationNs = endTime - startTime;
    const durationMs = Number(durationNs) / 1_000_000;
    const indent = '  '.repeat(this.depth);
    const attrs = Object.fromEntries(this.attributes);
    const status = Exit.isSuccess(exit) ? 'ok' : 'error';
    // eslint-disable-next-line no-console
    console.log(
      `${indent}[trace] ${this.name} ${durationMs.toFixed(2)}ms (${status})`,
      Object.keys(attrs).length > 0 ? attrs : '',
    );
    this.status = { _tag: 'Ended', startTime, endTime, exit };
  }

  attribute(key: string, value: unknown): void {
    this.attributes.set(key, value);
  }

  event(
    _name: string,
    _startTime: bigint,
    _attributes?: Record<string, unknown>,
  ): void {
    // no-op for console tracer
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.links.push(...links);
  }
}

function getDepth(parent: Option.Option<Tracer.AnySpan>): number {
  if (parent._tag === 'None') return 0;
  const p = parent.value;
  if (p._tag === 'ExternalSpan') return 0;
  return 1 + getDepth((p as Tracer.Span).parent);
}

/**
 * A Tracer that logs spans to console when they end. No optional dependencies
 * required. Use `consoleTracerLayer` when running your program to enable.
 *
 * @example
 * ```ts
 * import { Effect } from 'effect';
 * import { AgentNetwork, consoleTracerLayer } from '@m4trix/core/matrix';
 *
 * const network = AgentNetwork.setup(({ ... }) => { ... });
 * const program = network.run().pipe(
 *   Effect.provide(consoleTracerLayer),
 *   Effect.scoped
 * );
 * Effect.runPromise(program);
 * ```
 */
export const consoleTracer: Tracer.Tracer = Tracer.make({
  span: (name, parent, context, links, startTime, kind) =>
    new ConsoleSpan(
      name,
      parent,
      context,
      links,
      startTime,
      kind,
      getDepth(parent),
    ),
  context: (f) => f(),
});

/**
 * Layer that provides the console tracer. Pipe your program with
 * `Effect.provide(consoleTracerLayer)` before running to see spans in stdout.
 */
export const consoleTracerLayer: Layer.Layer<never> = Layer.setTracer(
  consoleTracer,
);
