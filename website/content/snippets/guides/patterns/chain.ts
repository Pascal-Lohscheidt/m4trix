import { AgentFactory, AgentNetwork, AgentNetworkEvent, S } from '@m4trix/core/matrix';

// #region events
export const UserMessage = AgentNetworkEvent.of('user-message', S.Struct({ text: S.String }));
export const Plan = AgentNetworkEvent.of('plan', S.Struct({ steps: S.Array(S.String) }));
export const Answer = AgentNetworkEvent.of('answer', S.Struct({ text: S.String }));
// #endregion events

// #region agents
export const planner = AgentFactory.run()
  .listensTo([UserMessage])
  .emits([Plan])
  .logic(async ({ triggerEvent, emit }) => {
    emit({
      name: 'plan',
      payload: { steps: [`search "${triggerEvent.payload.text}"`, 'summarize'] },
    });
  })
  .produce({});

export const executor = AgentFactory.run()
  .listensTo([Plan])
  .emits([Answer])
  .logic(async ({ triggerEvent, emit }) => {
    emit({ name: 'answer', payload: { text: `Ran ${triggerEvent.payload.steps.join(' → ')}` } });
  })
  .produce({});
// #endregion agents

// #region wiring
export const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
    const plans = createChannel('plans').events([Plan]);
    const client = createChannel('client').events([Answer]).proxy(proxy.sse());

    registerAgent(planner).subscribe(mainChannel).publishTo(plans);
    registerAgent(executor).subscribe(plans).publishTo(client);

    endsOn(Answer);
  },
);
// #endregion wiring

// #region scenario
export const scenario = {
  start: UserMessage.make({ text: 'What changed in the last release?' }),
};
// #endregion scenario
