import { AgentFactory, Done } from '@m4trix/core';
import {
  ReasoningForProblemCompleted,
  ReasoningForProblemReuqested,
  ReasoningForProblemThoughtChunkCreated,
} from './events';
import { from, lastValueFrom, map, tap } from 'rxjs';
import { reasoningSkill } from '@/skills/reasoning.skill';

export const reasoningAgent = AgentFactory.run()
  .listensTo([ReasoningForProblemReuqested])
  .emits([ReasoningForProblemThoughtChunkCreated, ReasoningForProblemCompleted])
  .logic(async ({ triggerEvent, emit }) => {
    const { problemToSolve } = triggerEvent.payload;

    const stream = reasoningSkill.invokeStream({ problemToSolve });

    const notDone = (chunk: string | Done<string>): chunk is string => !Done.is(chunk);

    await lastValueFrom(
      from(stream).pipe(
        map((chunk) =>
          notDone(chunk)
            ? ReasoningForProblemThoughtChunkCreated.make({ chunk })
            : ReasoningForProblemCompleted.make({ result: chunk.done }),
        ),
        tap(emit),
      ),
    );
  })
  .produce({});
