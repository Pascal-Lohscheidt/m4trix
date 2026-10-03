import { describe, expect, it } from 'vitest';
import assert from './assert';
import { createCredentialChain, fromEnv, fromNodeProviderChain } from './aws-credential-providers';

describe('browser shims', () => {
  it('assert passes truthy values and throws with the message otherwise', () => {
    expect(() => assert('GET')).not.toThrow();
    expect(() => assert(undefined, 'Expected request method')).toThrow('Expected request method');
  });

  it('credential provider shims refuse to resolve', () => {
    for (const fn of [createCredentialChain, fromEnv, fromNodeProviderChain]) {
      expect(() => fn()).toThrow('not available in the browser');
    }
  });
});
