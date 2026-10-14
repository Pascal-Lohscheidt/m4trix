import { AgentNetwork } from '@m4trix/core/matrix';
import { toM4trixTracer } from '@m4trix/tracing';
import { assistantAgent } from './assistant-agent.js';
import {
  CommandApprovalRequested,
  CommandApprovalResolved,
  MessageEvent,
  MessageStreamChunkEvent,
  SubAgentTaskCompleted,
  SubAgentTaskRequested,
  ToolUsedEvent,
} from './events.js';
import { backgroundSubAgent } from './sub-agent.js';
import { WithAgentMemoryLayer } from './dependency-layers/with-agent-memory.js';
import { WithFileSystemLayer } from './dependency-layers/with-file-system.js';
import { WithTavelyWebsearchLayer } from './dependency-layers/tavely-websearch.js';
import { tracer } from '../tracing/setup.js';

export const network = AgentNetwork.dependsOn([
  WithTavelyWebsearchLayer,
  WithFileSystemLayer,
  WithAgentMemoryLayer,
]).setup(
  ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
    // What the CLI sees (and the approvals it sends back through the proxy).
    const client = createChannel('client')
      .proxy(proxy.sse())
      .events([
        MessageStreamChunkEvent,
        MessageEvent,
        ToolUsedEvent,
        CommandApprovalRequested,
        CommandApprovalResolved,
      ]);
    // Delegation to the background sub-agent.
    const sub = createChannel('sub').events([SubAgentTaskRequested, SubAgentTaskCompleted]);

    // Each emit lands on the channels that accept it: the assistant's output on client, its
    // sub-agent tasks on sub.
    registerAgent(assistantAgent).subscribe(mainChannel).publishTo(client).publishTo(sub);
    // The sub-agent's tool progress reaches the client too; its task result answers the spawn
    // tool's emitAndAwait on sub.
    registerAgent(backgroundSubAgent).subscribe(sub).publishTo(sub).publishTo(client);

    // A turn ends with the assistant's reply. The user's message is the same event: match on role.
    endsOn(MessageEvent, (event) => event.payload.role === 'assistant');
  },
  {
    consoleTracing: process.env.ASSISTANT_WITH_LOGS === '1',
    networkTracer: toM4trixTracer(tracer),
  },
);
