import { Broadcast, SignIn } from '@phosphor-icons/react';
import { Agent, Channel, EventStack, Frame, Network, Port } from '../lib';
import type { SceneMeta } from './manifest';

/**
 * concepts/networks.md: the static anatomy of a network.
 *
 * Agents sit where channels overlap: a planner in main ∩ processing subscribes to one and
 * publishes to the other. The client channel leaves the network through its sse() proxy.
 */
export function NetworkAnatomy({ meta }: { meta: SceneMeta }) {
  return (
    <Frame width={meta.width} height={meta.height}>
      <Network box={{ x: 150, y: 110, w: 980, h: 670 }} />

      <Channel name="main" tone="sand" box={{ x: 200, y: 200, w: 900, h: 170 }} />
      <Channel name="processing" tone="rose" box={{ x: 520, y: 160, w: 250, h: 580 }} />
      <Channel
        name="client"
        tone="mint"
        box={{ x: 520, y: 560, w: 790, h: 170 }}
        labelOffset={282}
      />

      <Port at={{ x: 150, y: 285 }} label="expose()" icon={<SignIn size={16} weight="bold" />} />
      <Port
        at={{ x: 1130, y: 645 }}
        label="proxy.sse()"
        icon={<Broadcast size={16} weight="bold" />}
      />

      <Agent at={{ x: 345, y: 285 }} name="loggerAgent" />
      <Agent at={{ x: 645, y: 285 }} name="plannerAgent" />
      <Agent at={{ x: 645, y: 645 }} name="executorAgent" />

      <EventStack at={{ x: 935, y: 290 }} name="user-message" payload="{ text }" />
      <EventStack at={{ x: 645, y: 467 }} name="plan-step" payload="{ step }" depth={1} />
      <EventStack at={{ x: 905, y: 650 }} name="response" payload="{ text, isFinal }" />
    </Frame>
  );
}
