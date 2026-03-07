import { AgentNetwork, EventAggregator } from '@m4trix/core/matrix';
import { exampleAgent } from './example-agent';
import { reasoningAgent } from './reasoning-agent';
import { MessageEvent, MessageStreamChunkEvent } from './events';

const eventAggregator = EventAggregator.listensTo([MessageStreamChunkEvent])
  .emits([MessageEvent])
  .emitWhen(({ triggerEvent }) => {
    return (
      triggerEvent.payload.role === 'assistant' && triggerEvent.payload.isFinal
    );
  })
  .mapToEmit(({ emit }) => {
    console.log('Double aggregation');
    emit(
      MessageEvent.make({
        role: 'assistant',
        message: 'Double aggregation',
      }),
    );
  });

export const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, sink, registerAgent, registerAggregator }) => {
    const main = mainChannel('main');
    const client = createChannel('client').sink(sink.httpStream());

    registerAgent(exampleAgent).subscribe(main).publishTo(client);
    registerAgent(reasoningAgent).subscribe(client).publishTo(client);

    registerAggregator(eventAggregator).subscribe(client).publishTo(client);
  },
);
