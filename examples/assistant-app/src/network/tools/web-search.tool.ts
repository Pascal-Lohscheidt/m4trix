import { S, Tool } from '@m4trix/core';

import { WithTavelyWebsearchLayer } from '../depedency-layers/tavely-websearch.js';
import { ToolUsedEvent } from '../events.js';

const searchResultSchema = S.Struct({
  title: S.String,
  url: S.String,
  content: S.String,
  score: S.optional(S.Number),
});

export const webSearchTool = Tool.of({
  name: 'webSearch',
  description:
    'Search the web for up-to-date information. Returns titles, URLs, and query-relevant content snippets per result.',
})
  .emits([ToolUsedEvent])
  .input(S.Struct({ query: S.String }))
  .output(S.Struct({ results: S.Array(searchResultSchema) }))
  .dependsOn(WithTavelyWebsearchLayer)
  .define(async ({ input, layers, emit, toolCallId }) => {
    emit(
      ToolUsedEvent.make({
        toolCallId,
        toolName: 'webSearch',
        phase: 'start',
        input: { query: input.query },
      }),
    );

    try {
      const results = await layers.WithTavelyWebsearchLayer.search(input.query);
      const output = { results };
      emit(
        ToolUsedEvent.make({
          toolCallId,
          toolName: 'webSearch',
          phase: 'end',
          output,
        }),
      );
      return output;
    } catch (error) {
      emit(
        ToolUsedEvent.make({
          toolCallId,
          toolName: 'webSearch',
          phase: 'end',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  });
