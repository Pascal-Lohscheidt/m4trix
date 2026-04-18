import type { AgentNetworkSetupContext } from '../../agent-network/agent-network.js';
import type { ConfiguredChannel } from '../../agent-network/channel.js';

type Params = {
  interfaceChannel: ConfiguredChannel;
  networkContext: AgentNetworkSetupContext;
};

// TODO: implement the agent swarm
export const createAgentSwarm = ({ networkContext }: Params): ConfiguredChannel => {
  const { createChannel, sink, registerAgent, spawner } = networkContext;

  const internalComs = createChannel('swarm-internal-com');

  // exposing the channel if needed
  return internalComs;
};
