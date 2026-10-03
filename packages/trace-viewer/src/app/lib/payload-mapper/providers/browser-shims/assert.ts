/** Browser shim for Node's `assert`, used by `@anthropic-ai/bedrock-sdk` SigV4 signing. */
export default function assert(value: unknown, message?: string): asserts value {
  if (!value) throw new Error(message ?? 'Assertion failed');
}
