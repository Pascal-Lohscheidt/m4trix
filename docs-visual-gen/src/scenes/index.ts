import type { ComponentType } from 'react';
import { FanOut } from './fan-out';
import { LogoSheet } from './logo-sheet';
import type { SceneProps } from './manifest';
import { NetworkAnatomy } from './network-anatomy';
import { RequestFlow } from './request-flow';
import { RetryTimelineScene } from './retry-timeline';

export const sceneComponents: Record<string, ComponentType<SceneProps>> = {
  'network-anatomy': NetworkAnatomy,
  'request-flow': RequestFlow,
  'fan-out': FanOut,
  'logo-sheet': LogoSheet,
  'retry-timeline': RetryTimelineScene,
};
