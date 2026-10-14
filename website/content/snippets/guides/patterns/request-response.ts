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
    emit({ name: 'answer', payload: { text: `You said: ${triggerEvent.payload.text}` } });
  })
  .produce({});
// #endregion agents

// #region wiring
export const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
    const client = createChannel('client').events([Answer]).proxy(proxy.sse());

    registerAgent(assistant).subscribe(mainChannel).publishTo(client);

    endsOn(Answer);
  },
);
// #endregion wiring

// #region scenario
export const scenario = {
  start: UserMessage.make({ text: 'Hello' }),
};
// #endregion scenario
