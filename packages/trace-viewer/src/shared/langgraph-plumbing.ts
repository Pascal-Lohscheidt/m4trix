/**
 * LangGraph plumbing spans that rarely matter when debugging. Shared by the MCP tree outline and
 * the UI's default filter group so agents and humans see the same trimmed tree.
 */
export const LANGGRAPH_PLUMBING_PATTERN = '^(ChannelWrite<.*>|Branch<.*>|__start__|__end__)$';
