import { AgentFactory, AgentNetwork, AgentNetworkEvent, S } from '@m4trix/core/matrix';

// #region events
export const UserMessage = AgentNetworkEvent.of('user-message', S.Struct({ text: S.String }));
export const Task = AgentNetworkEvent.of('task', S.Struct({ topic: S.String }));
export const Answer = AgentNetworkEvent.of('answer', S.Struct({ text: S.String }));
// #endregion events

// #region agents
export const router = AgentFactory.run()
  .listensTo([UserMessage])
  .emits([Task])
  .logic(async ({ triggerEvent, emit }) => {
    emit({ name: 'task', payload: { topic: triggerEvent.payload.text } });
  })
  .produce({});

export const worker = AgentFactory.run()
  .listensTo([Task])
  .emits([Answer])
  .logic(async ({ triggerEvent, emit }) => {
    emit({ name: 'answer', payload: { text: `Looked into: ${triggerEvent.payload.topic}` } });
  })
  .produce({});

// No listensTo: it receives every event on the channels it subscribes to.
export const auditLog = AgentFactory.run()
  .logic(async ({ triggerEvent }) => {
    console.log('[audit]', triggerEvent);
  })
  .produce({});
// #endregion agents

// #region wiring
export const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
    const work = createChannel('work').events([Task]);
    const client = createChannel('client').events([Answer]).proxy(proxy.sse());

    registerAgent(router).subscribe(mainChannel).publishTo(work);
    registerAgent(worker).subscribe(work).publishTo(client);
    registerAgent(auditLog).subscribe(mainChannel).subscribe(work);

    endsOn(Answer);
  },
);
// #endregion wiring

// #region scenario
/** What the docs recorder publishes to start a run of this snippet. */
export const scenario = {
  start: UserMessage.make({ text: 'Why did checkout get slower?' }),
};
// #endregion scenario
