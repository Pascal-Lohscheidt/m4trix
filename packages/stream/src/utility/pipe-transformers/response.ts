import type { StreamTransformer } from '../../Pump';

export interface HttpStreamOptions<T> {
  /** HTTP ResponseInit (status, headers, etc.) */
  init?: ResponseInit;
  /** Encode each chunk of type T into bytes or string */
  encoder?: (data: T) => Uint8Array | string;
}

/**
 * Create a streaming HTTP response transformer.
 * Returns an object with:
 * - transform: function to write each chunk into the response
 * - response: the Fetch API Response ready to return
 * - close: function to close the stream when done
 *
 * Usage in a Next.js route:
 * ```
 * // With the new drainTo API:
 * const transformer = httpStreamResponse(options);
 * return Pump.from(messageStream).drainTo(transformer);
 *
 * // Or with manual control:
 * const { transform, response, close } = httpStreamResponse(options);
 * await Pump.from(messageStream).map(transform).drain();
 * close();
 * return response;
 * ```
 */
export function httpStreamResponse<T>(
  options: HttpStreamOptions<T> = {},
): StreamTransformer<T, Response> {
  const { init, encoder } = options;
  const encodeFn =
    encoder ??
    ((d: T): Uint8Array | string => {
      if (d instanceof Uint8Array) return d;
      if (typeof d === 'string') return d;
      return JSON.stringify(d);
    });

  // Create a transform stream of Uint8Array
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const response = new Response(readable, init);

  const transform = (chunk: T): T => {
    const encoded = encodeFn(chunk);
    const bytes = typeof encoded === 'string' ? new TextEncoder().encode(encoded) : encoded;
    writer.write(bytes);
    return chunk;
  };

  const close = (): void => {
    writer.close();
  };

  return { transform, response, close };
}
