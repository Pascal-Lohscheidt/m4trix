/**
 * Shared building blocks for every docs visual. Scenes only compose these; restyle or
 * re-animate a component here and every scene picks it up on the next render.
 */
export { Agent, animateAgentRun } from './Agent';
export { Channel, type ChannelTone } from './Channel';
export { ClientCard, clearClient, revealClientLine } from './ClientCard';
export { EventStack } from './EventStack';
export { Frame } from './Frame';
export type { Box, Point } from './geometry';
export { Network } from './Network';
export { animatePortFlash, Port } from './Port';
export { Tag } from './Tag';
export { Token, tokenIn, tokenOut, tokenTravel } from './Token';
export { Wires } from './Wires';
