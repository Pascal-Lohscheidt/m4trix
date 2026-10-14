/**
 * The public surface of `@m4trix/core` (`.`, `./matrix`, `./testing`): what users need is
 * exported, internal helpers and removed APIs are not. The full surface, with signatures, is
 * checked by the API report (`pnpm --filter @m4trix/core api:check`).
 */
import { describe, expect, expectTypeOf, test } from 'vitest';
import type {
  AgentNetworkSetupContext,
  AgentNetworkStore,
  AgentNetworkStoreKey,
  AuthResult,
  DependencyLayerDef,
  DependencyLayerInstance,
  DependencyLayerValue,
  Envelope,
  EventHistory,
  EventPlane,
  EventTransport,
  NetworkLogger,
  NetworkMetric,
  NetworkMetricName,
  NetworkTracer,
  NetworkTraceStatus,
  Principal,
  RunLifecycleEventName,
  RunMeta,
  RunOutcome,
  StoredEvent,
  WiringErrorCode,
} from './index.js';
import * as root from './index.js';
import * as matrix from './matrix/index.js';
import * as testing from './testing/index.js';

/** Runtime exports of the root entry point that users rely on. */
const expectedValues = [
  'AgentFactory',
  'AgentNetwork',
  'AgentNetworkEvent',
  'AgentAbortedError',
  'AgentParamsError',
  'ConfiguredChannel',
  'ChannelName',
  'ContextFold',
  'ContextFoldDefinitionError',
  'ContextStrategy',
  'DEFAULT_RECONNECT_WINDOW',
  'DEFAULT_RUN_IDLE_TIMEOUT',
  'DEFAULT_RUN_MAX_DURATION',
  'DependencyLayer',
  'DependencyLayerInstanceTypeId',
  'Done',
  'EmitValidationError',
  'EventAggregator',
  'ExposeAuthError',
  'ExposeRunNotFoundError',
  'ExposeValidationError',
  'ExpressEndpoint',
  'LayerName',
  'NetworkStoreError',
  'NetworkWiringError',
  'NextEndpoint',
  'Proxy',
  'PublishAndAwaitTimeoutError',
  'RunCancelledError',
  'RunLifecycleEvent',
  'RunLimitExceededError',
  'RunTimeoutError',
  'RunUnavailableError',
  'S',
  'SegmentedFold',
  'Skill',
  'Tool',
  'ToolDefinitionError',
  'ToolExecutionError',
  'ToolInputError',
  'ToolOutputError',
  'ToolTimeoutError',
  'consoleNetworkLogger',
  'consoleNetworkTracer',
  'createInMemoryNetworkStore',
  'createInMemoryTransport',
  'defineProxyKind',
  'isRunEndEnvelope',
  'isRunLifecycleEnvelope',
  'noopNetworkTracer',
  'noopRunTraceScope',
  'registerCustomProxy',
  'registerSSEStream',
  'approxTokenCount',
  'toAiSdkTools',
  'toAnthropicTools',
  'toOpenAITools',
];

/** Names that are internal (or removed) and must not be part of the public surface. */
const hiddenValues = [
  // removed APIs
  'SocketIoFactory',
  'DepedencyLayer',
  // generic names kept off the root: the strategies live on ContextStrategy
  'approxTokens',
  'dropOldest',
  'elide',
  // internal helpers
  'addFoldSources',
  'agentFailureOutcome',
  'assertDependencyMatch',
  'assertLayersProvided',
  'assertUniqueLayerNames',
  'channelAcceptsEvent',
  'channelHasProxy',
  'createFoldCache',
  'createFoldReader',
  'createInboundPublisher',
  'createInteractiveStream',
  'createProxyExposeContext',
  'createView',
  'foldAccessors',
  'guardNetworkTracer',
  'inspectEventPlane',
  'isSegmentedState',
  'limitExceededOutcome',
  'mergeDependencyLayers',
  'outcomeError',
  'outcomeTraceStatus',
  'pickRunLimits',
  'resolveChannelsForProxyKind',
  'resolveFoldCacheOptions',
  'resolveRunLimits',
  'runEndEnvelope',
  'runUnavailableEnvelope',
  'serializeAgentError',
  'serializeError',
  'storeErrorOutcome',
  'streamFailedEnvelope',
  'toLayerArray',
  'toToolArray',
  'traceEndStatus',
  'tracerFailureLogger',
  'withRunUsage',
];

describe('public API', () => {
  test('the root entry point exports what users need', () => {
    for (const name of expectedValues) expect(root, name).toHaveProperty(name);
  });

  test('internal helpers and removed APIs are not exported', () => {
    const exported = Object.keys(root);
    expect(exported.filter((name) => hiddenValues.includes(name))).toEqual([]);
  });

  test('./matrix exports the same values as the root entry point', () => {
    expect(Object.keys(matrix).sort()).toEqual(Object.keys(root).sort());
  });

  test('./testing exports the contract suites only', () => {
    expect(Object.keys(testing).sort()).toEqual(['runStoreContract', 'runTransportContract']);
  });

  test('Proxy offers sse and custom; Kafka and Socket.IO are not built in', () => {
    expect(Object.keys(root.Proxy).sort()).toEqual(['custom', 'sse']);
  });

  test('the setup context has no spawner', () => {
    expectTypeOf<AgentNetworkSetupContext>().not.toHaveProperty('spawner');
    expectTypeOf<'spawner-listen-not-accepted'>().not.toMatchTypeOf<WiringErrorCode>();
  });

  test('types users need are exported', () => {
    expectTypeOf<Envelope>().toHaveProperty('meta');
    expectTypeOf<RunMeta>().toEqualTypeOf<{ runId: string; contextId: string }>();
    expectTypeOf<EventPlane>().toHaveProperty('publish');
    expectTypeOf<EventTransport>().toBeObject();
    expectTypeOf<AgentNetworkStore>().toHaveProperty('append');
    expectTypeOf<AgentNetworkStoreKey>().toHaveProperty('namespace');
    expectTypeOf<StoredEvent>().toHaveProperty('name');
    expectTypeOf<EventHistory>().toBeObject();
    expectTypeOf<NetworkLogger>().toBeObject();
    expectTypeOf<NetworkMetric>().toHaveProperty('name');
    expectTypeOf<NetworkMetricName>().toBeString();
    expectTypeOf<NetworkTracer>().toHaveProperty('onRunStart');
    expectTypeOf<NetworkTraceStatus>().toEqualTypeOf<'ok' | 'error' | 'cancelled'>();
    expectTypeOf<Principal>().toHaveProperty('id');
    expectTypeOf<AuthResult>().toBeObject();
    expectTypeOf<RunLifecycleEventName>().toBeString();
    expectTypeOf<RunOutcome>().toBeObject();
    expectTypeOf<DependencyLayerDef<'Db', { query: () => void }, typeof root.S.String>>()
      .toHaveProperty('_tag')
      .toEqualTypeOf<'DependencyLayerDef'>();
    expectTypeOf<
      DependencyLayerValue<{ q: number }, typeof root.S.String>['config']
    >().toBeString();
    expectTypeOf<DependencyLayerValue<{ q: number }, typeof root.S.String>['q']>().toBeNumber();
    expectTypeOf<DependencyLayerInstance<'Db', object, typeof root.S.String>>().toHaveProperty(
      'config',
    );
  });

  test('removed types stay removed', () => {
    // Inline type imports rather than named imports, so sorting imports can't separate the
    // directives from the names they cover. If a name comes back, the directive goes unused.
    // @ts-expect-error the spawner API was removed
    expectTypeOf<import('./index.js').SpawnerBuilder>().toBeAny();
    // @ts-expect-error the socket.io helpers were removed
    expectTypeOf<import('./index.js').SocketEventName>().toBeAny();
  });

  test('internal and generic type names are not exported', () => {
    // @ts-expect-error the runtime's view options are internal
    expectTypeOf<import('./index.js').RuntimeViewOptions>().toBeAny();
    // @ts-expect-error strategies are typed as ContextStrategy, not a generic Strategy
    expectTypeOf<import('./index.js').Strategy<string>>().toBeAny();
    // @ts-expect-error the segment strategy type is SegmentContextStrategy
    expectTypeOf<import('./index.js').SegmentStrategy<string>>().toBeAny();
    // @ts-expect-error a strategy's second argument is ContextStrategyBudget
    expectTypeOf<import('./index.js').StrategyContext<string>>().toBeAny();
  });
});
