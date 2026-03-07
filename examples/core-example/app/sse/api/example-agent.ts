import { AgentFactory } from '@m4trix/core';
import { filter, from, lastValueFrom, map, reduce, take, tap } from 'rxjs';
import OpenAI from 'openai';

import { MessageEvent, MessageStreamChunkEvent, ReasoningForProblemReuqested } from './events';

export const exampleAgent = AgentFactory.run()
  .listensTo([MessageEvent])
  .emits([MessageStreamChunkEvent, MessageEvent, ReasoningForProblemReuqested])
  .logic(async ({ triggerEvent, emit, contextEvents }) => {
    if (!MessageEvent.is(triggerEvent)) {
      return;
    }

    const message = triggerEvent.payload.message;
    const role = triggerEvent.payload.role as 'user' | 'assistant';
    const messageHistory = contextEvents.all.filter(MessageEvent.is);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o',
      stream: true,
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_current_time',
            description: 'Get the current time',
          },
        },
      ],
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant. Think step by step and explain your reasoning.',
        },
        ...messageHistory.map((event) => ({
          role: event.payload.role as 'user' | 'assistant',
          content: event.payload.message,
        })),
        { role, content: message },
      ],
    });

    const finalResponse = await lastValueFrom(
      from(stream).pipe(
        map((chunk) => chunk.choices[0]?.delta?.content),
        filter((content): content is string => content != null),
        map((content) =>
          MessageStreamChunkEvent.make({
            chunk: content,
            isFinal: false,
            role: 'assistant',
          }),
        ),
        tap(emit),
        filter(MessageStreamChunkEvent.is),
        reduce((acc, event) => acc + event.payload.chunk, ''),
        take(1),
      ),
    );

    emit(
      ReasoningForProblemReuqested.make({
        problemToSolve: 'How does gravity affect light and dark matter?',
      }),
    );

    emit(
      MessageStreamChunkEvent.make({
        chunk: '',
        isFinal: true,
        role: 'assistant',
      }),
    );
    emit(
      MessageEvent.make({
        message: finalResponse,
        role: 'assistant',
      }),
    );
  })
  .produce({});
