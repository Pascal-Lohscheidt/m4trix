// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type AgentNetworkStore,
  ANONYMOUS_NAMESPACE,
  createInMemoryNetworkStore,
  type EventHistory,
  type Principal,
  principalNamespace,
} from '../matrix/index.js';
import {
  runStoreContract,
  runTransportContract,
  type StoreContractTestApi,
  type TransportContractTestApi,
} from './index.js';

describe('@m4trix/core/testing', () => {
  // The public contract suite, run against the public in-memory store.
  runStoreContract({ describe, it, expect }, () => createInMemoryNetworkStore());

  it('exports the store API from @m4trix/core/matrix', () => {
    expect(ANONYMOUS_NAMESPACE).toBe('anonymous');
    expect(principalNamespace('alice')).toBe('principal:alice');
    expect(principalNamespace(undefined)).toBe('anonymous');
    expectTypeOf(createInMemoryNetworkStore()).toEqualTypeOf<AgentNetworkStore>();
    expectTypeOf<EventHistory>().toHaveProperty('context');
    expectTypeOf<Principal>().toHaveProperty('id');
    expectTypeOf<StoreContractTestApi>().toHaveProperty('expect');
    expectTypeOf<TransportContractTestApi>().toEqualTypeOf<StoreContractTestApi>();
    expect(typeof runTransportContract).toBe('function');
  });

  it('pulls in no test framework or other package but effect: test functions are injected', () => {
    for (const file of [
      new URL('./index.ts', import.meta.url),
      new URL('../matrix/agent-network/stores/store-contract.ts', import.meta.url),
      new URL('../matrix/agent-network/transport-contract.ts', import.meta.url),
    ]) {
      const source = readFileSync(file, 'utf8');
      const imports = [...source.matchAll(/^(?:import|export)[^;]*?from '([^']+)'/gm)].map(
        (m) => m[1],
      );
      expect(imports.length).toBeGreaterThan(0);
      expect(imports.filter((from) => !from?.startsWith('.') && from !== 'effect')).toEqual([]);
    }
  });
});
