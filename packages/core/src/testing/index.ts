/**
 * Test helpers for code built on `@m4trix/core`. Nothing here imports a test framework: pass
 * your runner's functions in (see `runStoreContract`).
 */
export {
  type CreateStore,
  runStoreContract,
  type StoreContractTestApi,
} from '../matrix/agent-network/stores/store-contract.js';
export {
  type CreateTransport,
  runTransportContract,
  type TransportContractTestApi,
} from '../matrix/agent-network/transport-contract.js';
