import { AgentNetwork } from '@m4trix/core/matrix';
import { toM4trixTracer } from '@m4trix/tracing';
import { assistantAgent } from './assistant-agent.js';
import { backgroundSubAgent } from './sub-agent.js';
import { WithAgentMemoryLayer } from './depedency-layers/with-agent-memory.js';
import { WithFileSystemLayer } from './depedency-layers/with-file-system.js';
import { WithTavelyWebsearchLayer } from './depedency-layers/tavely-websearch.js';
import { tracer } from '../tracing/setup.js';

export const network = AgentNetwork.dependsOn([
  WithTavelyWebsearchLayer,
  WithFileSystemLayer,
  WithAgentMemoryLayer,
]).setup(
  ({ mainChannel, createChannel, proxy, registerAgent }) => {
    const client = createChannel('client').proxy(proxy.sse());
    const sub = createChannel('sub');

    registerAgent(assistantAgent).subscribe(mainChannel).publishTo(client).publishTo(sub);
    registerAgent(backgroundSubAgent).subscribe(sub).publishTo(sub);
  },
  {
    consoleTracing: process.env.ASSISTANT_WITH_LOGS === '1',
    networkTracer: toM4trixTracer(tracer),
  },
);
