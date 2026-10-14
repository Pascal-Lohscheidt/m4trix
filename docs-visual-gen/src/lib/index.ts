/**
 * Shared building blocks for every docs visual. Scenes only compose these; restyle or
 * re-animate a component here and every scene picks it up on the next render.
 *
 * Everything is positioned in canvas pixels inside a <Frame> (or <ScaledFrame>), styles are
 * scoped to `.dv-frame` and every class is prefixed `dv-`. Components are server-safe except
 * ScaledFrame ('use client'); motion helpers only add tweens to a timeline you own.
 */
export { Agent, animateAgentRun } from './Agent';
export { Channel, type ChannelTone } from './Channel';
export { ClientCard, clearClient, revealClientLine } from './ClientCard';
export { EventStack } from './EventStack';
export { Frame, type FrameProps, type FrameTheme } from './Frame';
export { type Box, boxStyle, Centered, type Point } from './geometry';
export type { TimelineLike } from './motion';
export { Network } from './Network';
export { animatePortFlash, Port } from './Port';
export {
  RetryTimeline,
  type RetryTimelineProps,
  retryTimelineLayout,
} from './RetryTimeline';
export { ScaledFrame, type ScaledFrameProps } from './ScaledFrame';
export { Tag, type TagEdge } from './Tag';
export { Token, tokenIn, tokenOut, tokenTravel } from './Token';
export { Wires } from './Wires';
