import { AgentFactory, AgentNetwork, AgentNetworkEvent, S } from '@m4trix/core/matrix';

// #region events
export const UserMessage = AgentNetworkEvent.of('user-message', S.Struct({ text: S.String }));
export const Answer = AgentNetworkEvent.of('answer', S.Struct({ text: S.String }));
// #endregion events

// #region agents
export const assistant = AgentFactory.run()
  .listensTo([UserMessage])
  .emits([Answer])
  .logic(async ({ triggerEvent, emit }) => {
    emit({ name: 'answer', payload: { text: `Re: ${triggerEvent.payload.text}` } });
  })
  .produce({});

// Side work on the same event: nothing to emit, so it never races the end of the run.
export const auditLog = AgentFactory.run()
  .listensTo([UserMessage])
  .logic(async ({ triggerEvent }) => {
    console.log('[audit]', triggerEvent.payload.text);
  })
  .produce({});

export const usageMeter = AgentFactory.run()
  .listensTo([UserMessage])
  .logic(async ({ triggerEvent }) => {
    console.log('[usage]', triggerEvent.payload.text.length, 'chars');
  })
  .produce({});
// #endregion agents

// #region wiring
export const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
    const client = createChannel('client').events([Answer]).proxy(proxy.sse());

    // Three subscribers on main: each gets its own copy of every user-message.
    registerAgent(assistant).subscribe(mainChannel).publishTo(client);
    registerAgent(auditLog).subscribe(mainChannel);
    registerAgent(usageMeter).subscribe(mainChannel);

    endsOn(Answer);
  },
);
// #endregion wiring

// #region scenario
export const scenario = {
  start: UserMessage.make({ text: 'Summarize the incident' }),
};
// #endregion scenario
