import { AgentFactory, AgentNetwork, AgentNetworkEvent, S } from '@m4trix/core/matrix';

// #region events
export const UserMessage = AgentNetworkEvent.of('user-message', S.Struct({ text: S.String }));
export const Task = AgentNetworkEvent.of('task', S.Struct({ query: S.String }));
export const TaskResult = AgentNetworkEvent.of('task-result', S.Struct({ rows: S.Number }));
export const Answer = AgentNetworkEvent.of('answer', S.Struct({ text: S.String }));
// #endregion events

// #region agents
export const coordinator = AgentFactory.run()
  .listensTo([UserMessage])
  .emits([Task, Answer])
  .logic(async ({ triggerEvent, emitAndAwait, emit }) => {
    // Publishes `task`, then waits for the event that answers it.
    const reply = await emitAndAwait(
      { name: 'task', payload: { query: triggerEvent.payload.text } },
      (event) => TaskResult.is(event),
      { timeout: '30 seconds' },
    );
    // The reply comes back as a plain envelope; the guard types its payload.
    if (!TaskResult.is(reply)) throw new Error('Unexpected reply');
    emit({ name: 'answer', payload: { text: `Found ${reply.payload.rows} rows` } });
  })
  .produce({});

export const worker = AgentFactory.run()
  .listensTo([Task])
  // A reply: nothing listens to it, the waiting coordinator receives it.
  .emits([TaskResult], { reply: true })
  .logic(async ({ emit }) => {
    emit({ name: 'task-result', payload: { rows: 42 } });
  })
  .produce({});
// #endregion agents

// #region wiring
export const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
    const work = createChannel('work').events([Task, TaskResult]);
    const client = createChannel('client').events([Answer]).proxy(proxy.sse());

    registerAgent(coordinator).subscribe(mainChannel).publishTo(work).publishTo(client);
    registerAgent(worker).subscribe(work).publishTo(work);

    endsOn(Answer);
  },
);
// #endregion wiring

// #region scenario
export const scenario = {
  start: UserMessage.make({ text: 'orders from last week' }),
};
// #endregion scenario
