/**
 * Browser shim for `@aws-sdk/credential-providers`. The trace viewer always passes explicit
 * credentials (Bedrock API key or access keys), so the Node default credential chain is never
 * needed; resolving it in the browser is an error.
 */
function unavailable(): never {
  throw new Error(
    'The AWS default credential chain is not available in the browser; enter keys explicitly.',
  );
}

export const createCredentialChain = unavailable;
export const fromEnv = unavailable;
export const fromNodeProviderChain = unavailable;
