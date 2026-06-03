import { S, Tool } from '@m4trix/core';

import { WithTavelyWebsearchLayer } from '../depedency-layers/tavely-websearch.js';
import { ToolUsedEvent } from '../events.js';

export const readWebPageTool = Tool.of({
  name: 'readWebPage',
  description:
    'Extract and read the full content of one or more web pages by URL. Use when you already have URLs and need deeper page text than search snippets.',
})
  .emits([ToolUsedEvent])
  .input(
    S.Struct({
      urls: S.Array(S.String),
      query: S.optional(S.String),
    }),
  )
  .output(
    S.Struct({
      pages: S.Array(
        S.Struct({
          url: S.String,
          content: S.String,
        }),
      ),
      failed: S.Array(
        S.Struct({
          url: S.String,
          error: S.String,
        }),
      ),
    }),
  )
  .dependsOn(WithTavelyWebsearchLayer)
  .define(async ({ input, layers, emit, toolCallId }) => {
    emit(
      ToolUsedEvent.make({
        toolCallId,
        toolName: 'readWebPage',
        phase: 'start',
        input: { urls: input.urls, query: input.query },
      }),
    );

    try {
      const { pages, failed } = await layers.WithTavelyWebsearchLayer.extract(input.urls, {
        query: input.query,
      });
      const output = { pages, failed };
      emit(
        ToolUsedEvent.make({
          toolCallId,
          toolName: 'readWebPage',
          phase: 'end',
          output,
        }),
      );
      return output;
    } catch (error) {
      emit(
        ToolUsedEvent.make({
          toolCallId,
          toolName: 'readWebPage',
          phase: 'end',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  });
