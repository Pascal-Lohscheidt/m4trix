import { Source } from '../../Pump';

/**
 * Creates a source from a Response body that can be used with Pump.from()
 *
 * This utility function extracts the ReadableStream from a Response object
 * and ensures it can be properly consumed by a Pump.
 *
 * @example
 * ```
 * const response = await fetch('https://api.example.com/stream');
 * const pump = Pump.from(responseBody(response));
 * ```
 *
 * @param response - The Response object containing a body to stream
 * @returns A Source that can be used with Pump.from()
 * @throws Error if the response body is null
 */
export function responseBody(response: Response): Source<Uint8Array> {
  if (!response.body) {
    throw new Error('Response body is null');
  }

  return response.body;
}
