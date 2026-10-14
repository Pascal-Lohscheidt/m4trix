import {
  AgentFactory,
  AgentNetwork,
  AgentNetworkEvent,
  EventAggregator,
  type EventHistory,
  S,
} from '@m4trix/core/matrix';

// #region events
export const UserMessage = AgentNetworkEvent.of('user-message', S.Struct({ text: S.String }));
export const Finding = AgentNetworkEvent.of('finding', S.Struct({ text: S.String }));
export const Critique = AgentNetworkEvent.of('critique', S.Struct({ text: S.String }));
export const Report = AgentNetworkEvent.of('report', S.Struct({ text: S.String }));
// #endregion events

// #region agents
export const researcher = AgentFactory.run()
  .listensTo([UserMessage])
  .emits([Finding])
  .logic(async ({ triggerEvent, emit }) => {
    emit({ name: 'finding', payload: { text: `Notes on ${triggerEvent.payload.text}` } });
  })
  .produce({});

export const critic = AgentFactory.run()
  .listensTo([UserMessage])
  .emits([Critique])
  .logic(async ({ emit }) => {
    emit({ name: 'critique', payload: { text: 'Check the sample size' } });
  })
  .produce({});
// #endregion agents

// #region join
// The run's events up to this trigger. Of the two invocations, only the one for whichever
// draft arrives second sees both, so the report is emitted exactly once.
async function draftsUpTo(history: EventHistory, trigger: { meta: { eventId?: string } }) {
  const events = await history.run();
  return events.slice(
    0,
    events.findIndex((event) => event.meta.eventId === trigger.meta.eventId) + 1,
  );
}

export const editor = EventAggregator.listensTo([Finding, Critique])
  .emits([Report])
  .emitWhen(async ({ history, triggerEvent }) => {
    const drafts = await draftsUpTo(history, triggerEvent);
    return drafts.some(Finding.is) && drafts.some(Critique.is);
  })
  .mapToEmit(async ({ history, triggerEvent, emit }) => {
    const drafts = await draftsUpTo(history, triggerEvent);
    const finding = drafts.find(Finding.is);
    const critique = drafts.find(Critique.is);
    emit({
      name: 'report',
      payload: { text: `${finding?.payload.text} (${critique?.payload.text})` },
    });
  });
// #endregion join

// #region wiring
export const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, proxy, registerAgent, registerAggregator, endsOn }) => {
    const drafts = createChannel('drafts').events([Finding, Critique]);
    const client = createChannel('client').events([Report]).proxy(proxy.sse());

    registerAgent(researcher).subscribe(mainChannel).publishTo(drafts);
    registerAgent(critic).subscribe(mainChannel).publishTo(drafts);
    registerAggregator(editor).subscribe(drafts).publishTo(client);

    endsOn(Report);
  },
);
// #endregion wiring

// #region scenario
export const scenario = {
  start: UserMessage.make({ text: 'the new caching layer' }),
};
// #endregion scenario
