import { randomUUID } from 'crypto';
import type {
  ContextEvents,
  RunEvents,
} from './agent-network/agent-network-event';

type LogicFn<TParams, TTriggerEvent, TEmitEvent> = (ctx: {
  params: TParams;
  triggerEvent: TTriggerEvent;
  emit: (event: TEmitEvent) => void;
  runEvents: RunEvents;
  contextEvents: ContextEvents;
}) => Promise<void>;

export class Agent<TParams, TTriggerEvent = never, TEmitEvent = never> {
  #params: TParams;
  #logic: LogicFn<TParams, TTriggerEvent, TEmitEvent>;
  #id: string;
  #listensTo: readonly string[];

  constructor(
    logic: LogicFn<TParams, TTriggerEvent, TEmitEvent>,
    params: TParams,
    listensTo?: readonly string[],
  ) {
    this.#logic = logic;
    this.#params = params;
    this.#id = `agent-${randomUUID()}`;
    this.#listensTo = listensTo ?? [];
  }

  getListensTo(): readonly string[] {
    return this.#listensTo;
  }

  async invoke(options?: {
    triggerEvent?: TTriggerEvent;
    emit?: (event: TEmitEvent) => void;
    runEvents?: RunEvents;
    contextEvents?: ContextEvents;
  }): Promise<void> {
    const { triggerEvent, emit, runEvents, contextEvents } = options ?? {};

    const emitFn =
      emit ??
      ((_event: TEmitEvent): void => {
        // no-op – will be wired by the network at runtime
      });

    await this.#logic({
      params: this.#params,
      triggerEvent: triggerEvent ?? (undefined as TTriggerEvent),
      emit: emitFn,
      runEvents: runEvents ?? [],
      contextEvents: contextEvents ?? {
        all: [],
        byRun: () => [],
        map: new Map(),
      },
    });
  }

  getId(): string {
    return this.#id;
  }
}
