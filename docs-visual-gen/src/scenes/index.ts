import type { ComponentType } from 'react';
import { FanOut } from './fan-out';
import type { SceneMeta } from './manifest';
import { NetworkAnatomy } from './network-anatomy';
import { RequestFlow } from './request-flow';

export const sceneComponents: Record<string, ComponentType<{ meta: SceneMeta }>> = {
  'network-anatomy': NetworkAnatomy,
  'request-flow': RequestFlow,
  'fan-out': FanOut,
};
