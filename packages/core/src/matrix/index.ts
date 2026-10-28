/**
 * The public API of `@m4trix/core` (also served as `@m4trix/core/matrix`). Every export is listed
 * by name: internal helpers stay out, and `api/*.api.md` records the surface (see the README).
 */
export {
  Agent,
  type AgentRunControls,
  type AgentRuntimeOptions,
  type EmitAndAwaitFn,
} from './agent.js';
export {
  AgentFactory,
  type EmitPayload,
  type EmitsOptions,
  type EventEnvelope,
} from './agent-factory.js';
export {
  type AgentBinding,
  AgentNetwork,
  AgentNetworkBuilder,
  type AgentNetworkSetupContext,
  type AgentNetworkSetupOptions,
  type AnyAgent,
  type NetworkRunOptions,
  type RunTerminalEvent,
} from './agent-network/agent-network.js';
export {
  AgentNetworkEvent,
  type AgentNetworkEventDef,
  type AgentNetworkEventOptions,
  type EnvelopeLike,
  type EventMeta,
  EventMetaSchema,
  S,
} from './agent-network/agent-network-event.js';
export {
  ChannelName,
  ConfiguredChannel,
  Proxy,
  type ProxyDef,
  type ProxyDirection,
} from './agent-network/channel.js';
export { EventAggregator, EventAggregatorInstance } from './agent-network/event-aggregator.js';
export {
  type Envelope,
  type EventPlane,
  PublishAndAwaitTimeoutError,
  type RunLimits,
  type RunMeta,
} from './agent-network/event-plane.js';
export { createInMemoryTransport, type EventTransport } from './agent-network/event-transport.js';
export type { EventHistory, HistoryScope } from './agent-network/history.js';
export {
  AgentAbortedError,
  type AgentErrorEnvelope,
  type AgentErrorPayload,
  type AgentErrorPolicy,
  DEFAULT_RECONNECT_WINDOW,
  DEFAULT_RUN_IDLE_TIMEOUT,
  DEFAULT_RUN_LIMITS,
  DEFAULT_RUN_MAX_DEPTH,
  DEFAULT_RUN_MAX_DURATION,
  DEFAULT_RUN_MAX_EVENTS,
  isReservedEventName,
  isRunEndEnvelope,
  isRunLifecycleEnvelope,
  NetworkStoreError,
  RESERVED_EVENT_PREFIX,
  ReservedEventNameError,
  type ResolvedRunLimits,
  type RunCancelledEnvelope,
  RunCancelledError,
  type RunCancelledPayload,
  type RunCompletedEnvelope,
  type RunCompletedPayload,
  type RunEndEnvelope,
  type RunEndUsage,
  type RunErrorKind,
  type RunFailedEnvelope,
  type RunFailedPayload,
  type RunLifecycleEnvelope,
  RunLifecycleEvent,
  type RunLifecycleEventName,
  RunLimitExceededError,
  type RunLimitName,
  type RunLimitOptions,
  type RunOutcome,
  RunTimeoutError,
  RunUnavailableError,
  type SerializedRunError,
} from './agent-network/run-lifecycle.js';
export { NonJsonPayloadError } from './agent-network/stored-payload.js';
export {
  type AgentNetworkStore,
  type AgentNetworkStoreKey,
  ANONYMOUS_NAMESPACE,
  type EventPage,
  principalNamespace,
  type ReadContextOptions,
  type StoredEvent,
} from './agent-network/stores/agent-network-store.js';
export {
  createInMemoryNetworkStore,
  DEFAULT_IN_MEMORY_STORE_MAX_CONTEXTS,
  DEFAULT_IN_MEMORY_STORE_TTL,
  type InMemoryNetworkStoreOptions,
} from './agent-network/stores/inmemory-network-store.js';
export {
  type NetworkValidationResult,
  NetworkWiringError,
  type NetworkWiringOptions,
  type WiringErrorCode,
  type WiringIssue,
  type WiringWarningCode,
} from './agent-network/wiring.js';
export { consoleTracer, consoleTracerLayer } from './console-tracer.js';
export {
  type AnyContextFold,
  ContextFold,
  type ContextFoldBase,
  type ContextFoldBuilder,
  ContextFoldDefinitionError,
  type ContextFoldOptions,
  type DeepReadonly,
  type DuplicateFoldHandler,
  type FoldReadStateOf,
  type FoldScope,
  type FoldStateOf,
  type InvalidFoldName,
  type UnhandledFoldEvent,
  type ValidFoldName,
} from './context/context-fold.js';
export {
  DEFAULT_FOLD_CACHE_MAX_ENTRIES,
  DEFAULT_FOLD_CACHE_TTL,
  type FoldCacheOptions,
} from './context/fold-cache.js';
export {
  type FoldCheckpointEnvelope,
  type FoldCheckpointEventName,
  type FoldCheckpointPayload,
  FoldCompactionError,
  type FoldCompactionErrorReason,
  foldCheckpointEventName,
  isFoldCheckpointEvent,
} from './context/fold-checkpoint.js';
export type {
  FoldAccessor,
  FoldCannotCompact,
  FoldCompact,
  FoldCompactFn,
  SegmentedCompactInput,
  SegmentedCompaction,
  SegmentedCompactOptions,
  SegmentedFoldCompact,
} from './context/fold-compaction.js';
export type {
  DuplicateFoldName,
  FoldAccessors,
  FoldReadAccessors,
  FoldReader,
  UniqueFolds,
} from './context/fold-reader.js';
export {
  type AnySegmentedFold,
  type AnySegmentedState,
  type InvalidSegmentTag,
  type KindNeedsSegmentTag,
  type Segment,
  type SegmentAttachOptions,
  type SegmentDataOf,
  type SegmentDataOfKind,
  SegmentedFold,
  type SegmentedFoldOptions,
  type SegmentedState,
  type SegmentKindOf,
  type SegmentOf,
  type SegmentTagOf,
  type SummaryOf,
  type ValidSegmentTag,
} from './context/segmented-fold.js';
export {
  ContextStrategy,
  type ContextStrategyBudget,
  type CountUnitOf,
  type DropOldestOptions,
  type ElideOptions,
  type KeepFrom,
  type SegmentContextStrategy,
} from './context/strategies.js';
export {
  approxTokenCount,
  ContextView,
  type ContextViewBuilder,
  type SegmentedContextView,
  type SegmentedViewOptions,
  type StateViewOptions,
  type ViewNeedsMeasure,
  type ViewReadOptions,
  type ViewResult,
  type ViewSplit,
  type ViewSplitOptions,
} from './context/view.js';
export {
  DependencyLayer,
  type DependencyLayerDef,
  type DependencyLayerInstance,
  DependencyLayerInstanceTypeId,
  type DependencyLayerValue,
  isDependencyLayerInstance,
  type LayerInstancesFromDeps,
  LayerName,
  type LayersFromDeps,
} from './dependency-layer.js';
export {
  type AuthResult,
  type BoundProxyPublisher,
  type CustomProxyConsumer,
  defineProxyKind,
  ExposeAuthError,
  type ExposedAPI,
  type ExposedStream,
  type ExposeRequest,
  ExposeRunNotFoundError,
  type ExposeRunNotFoundErrorBody,
  ExposeValidationError,
  type ExposeValidationErrorBody,
  ExpressEndpoint,
  type ExpressEndpointOptions,
  type ExpressHandler,
  type ExpressRequest,
  type ExpressResponse,
  type FormatSSEOptions,
  formatSSE,
  type InteractiveProxyHandle,
  NextEndpoint,
  type NextEndpointOptions,
  type NextGetHandler,
  type OnRequestContext,
  ProxyConsumer,
  type ProxyEventMeta,
  type ProxyExposeContext,
  type ProxyPrincipalOptions,
  type PublishInboundOptions,
  type PublishTarget,
  registerCustomProxy,
  registerSSEStream,
  SSE_HEARTBEAT,
  type SseProxyConsumer,
  type SseProxyConsumerOptions,
  type StreamFactory,
  sseEventId,
  toSSEStream,
  type UnboundEvent,
} from './io/index.js';
export { consoleNetworkLogger, type NetworkLogger } from './logger.js';
export type {
  NetworkMetric,
  NetworkMetricHandler,
  NetworkMetricName,
  RunMetricStatus,
} from './metrics.js';
export type { Principal } from './principal.js';
export {
  Done,
  Skill,
  type SkillDefineContext,
  type SkillInstance,
  type SkillRuntime,
  type SkillRuntimeOptions,
} from './skill.js';
export {
  AgentToolCollection,
  type AnyToolDefinition,
  type BoundTool,
  TOOL_NAME_PATTERN,
  Tool,
  type ToolBindOptions,
  type ToolDefinition,
  type ToolDeps,
  type ToolEmitAndAwaitFn,
  type ToolEmitFn,
  type ToolExecuteOptions,
  type ToolExecutionContext,
  type ToolRetryOptions,
  type ToolRunControls,
  type ToolSchema,
} from './tool.js';
export {
  ToolDefinitionError,
  ToolExecutionError,
  ToolInputError,
  type ToolIssue,
  type ToolModelError,
  type ToolModelErrorKind,
  type ToolModelResult,
  ToolOutputError,
  ToolTimeoutError,
  toToolModelError,
} from './tool-errors.js';
export {
  type AiSdkHelpers,
  type AiSdkTool,
  type AiSdkToolCallOptions,
  type AnthropicTool,
  type OpenAIFunctionTool,
  type ToolJsonSchema,
  type ToolParametersJsonSchema,
  toAiSdkTools,
  toAnthropicTools,
  toOpenAITools,
} from './tool-formatters.js';
export {
  consoleNetworkTracer,
  type NetworkTraceEndOptions,
  type NetworkTracer,
  type NetworkTraceStatus,
  type NetworkUsageEvent,
  noopNetworkTracer,
  noopRunTraceScope,
  type RunSpan,
  type RunTraceScope,
  type TraceRunType,
} from './tracing/network-tracer.js';
export type {
  RunUsage,
  UsageReport,
  UsageReporter,
  UsageSource,
  UsageTotals,
} from './usage.js';
export {
  AgentParamsError,
  EmitValidationError,
  type EmitViolation,
  isEmitValidationError,
  type ValidationIssue,
} from './validation.js';
