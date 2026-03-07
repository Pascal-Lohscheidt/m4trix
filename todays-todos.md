## Event Aggregation

```ts


    const eventAggregator = EventAggregator.listensTo([MessageEvent]).emits([MessageEvent]).emitWhen(({triggerEvent, contextEvents}) => true | false).mapToEmit({emit, triggerEvent, contextEvents} => {

      emit(MessageEvent.make({...dreived from triggerEvent and contextEvents}));
    })

    registerAggregator(eventAggregator).subscribe(main).publishTo(client);

  
´´´

I want the eventAggregator to be pretty much acting like a registered agent but just more limited.
please create a file in /matrix/agent-network  that is called event-aggregator.ts and define spec file first.

please first define the tests and then the code. Orient yourself heavily from the agent

put an example into the examples/core-example/app/api/reasoning/network.ts file at the end

