import { S, Tool } from '@m4trix/core';

import { WithFileSystemLayer } from '../depedency-layers/with-file-system.js';
import { ToolUsedEvent } from '../events.js';

const fileSystemEntrySchema = S.Struct({
  name: S.String,
  path: S.String,
  type: S.Literal('file', 'directory', 'other'),
});

export const listDirectoryTool = Tool.of({
  name: 'listDirectory',
  description:
    'List files and folders in a directory under the configured filesystem root. Use "." for the root directory.',
})
  .emits([ToolUsedEvent])
  .input(S.Struct({ path: S.optional(S.String) }))
  .output(S.Struct({ entries: S.Array(fileSystemEntrySchema) }))
  .dependsOn(WithFileSystemLayer)
  .define(async ({ input, layers, emit, toolCallId }) => {
    const path = input.path ?? '.';
    emit(
      ToolUsedEvent.make({
        toolCallId,
        toolName: 'listDirectory',
        phase: 'start',
        input: { path },
      }),
    );

    try {
      const entries = await layers.WithFileSystemLayer.listDirectory(path);
      const output = { entries };
      emit(
        ToolUsedEvent.make({
          toolCallId,
          toolName: 'listDirectory',
          phase: 'end',
          output,
        }),
      );
      return output;
    } catch (error) {
      emit(
        ToolUsedEvent.make({
          toolCallId,
          toolName: 'listDirectory',
          phase: 'end',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  });

export const readTextFileTool = Tool.of({
  name: 'readTextFile',
  description: 'Read a UTF-8 text file under the configured filesystem root.',
})
  .emits([ToolUsedEvent])
  .input(S.Struct({ path: S.String }))
  .output(S.Struct({ path: S.String, content: S.String }))
  .dependsOn(WithFileSystemLayer)
  .define(async ({ input, layers, emit, toolCallId }) => {
    emit(
      ToolUsedEvent.make({
        toolCallId,
        toolName: 'readTextFile',
        phase: 'start',
        input: { path: input.path },
      }),
    );

    try {
      const content = await layers.WithFileSystemLayer.readTextFile(input.path);
      const output = { path: input.path, content };
      emit(
        ToolUsedEvent.make({
          toolCallId,
          toolName: 'readTextFile',
          phase: 'end',
          output: { path: output.path, bytes: Buffer.byteLength(content, 'utf8') },
        }),
      );
      return output;
    } catch (error) {
      emit(
        ToolUsedEvent.make({
          toolCallId,
          toolName: 'readTextFile',
          phase: 'end',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  });

export const writeTextFileTool = Tool.of({
  name: 'writeTextFile',
  description:
    'Write UTF-8 text to a file under the configured filesystem root, creating parent directories as needed.',
})
  .emits([ToolUsedEvent])
  .input(S.Struct({ path: S.String, contents: S.String }))
  .output(S.Struct({ path: S.String, written: S.Boolean }))
  .dependsOn(WithFileSystemLayer)
  .define(async ({ input, layers, emit, toolCallId }) => {
    emit(
      ToolUsedEvent.make({
        toolCallId,
        toolName: 'writeTextFile',
        phase: 'start',
        input: { path: input.path, bytes: Buffer.byteLength(input.contents, 'utf8') },
      }),
    );

    try {
      await layers.WithFileSystemLayer.writeTextFile(input.path, input.contents);
      const output = { path: input.path, written: true };
      emit(
        ToolUsedEvent.make({
          toolCallId,
          toolName: 'writeTextFile',
          phase: 'end',
          output,
        }),
      );
      return output;
    } catch (error) {
      emit(
        ToolUsedEvent.make({
          toolCallId,
          toolName: 'writeTextFile',
          phase: 'end',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  });

export const fileExistsTool = Tool.of({
  name: 'fileExists',
  description: 'Check whether a file or directory exists under the configured filesystem root.',
})
  .emits([ToolUsedEvent])
  .input(S.Struct({ path: S.String }))
  .output(S.Struct({ path: S.String, exists: S.Boolean }))
  .dependsOn(WithFileSystemLayer)
  .define(async ({ input, layers, emit, toolCallId }) => {
    emit(
      ToolUsedEvent.make({
        toolCallId,
        toolName: 'fileExists',
        phase: 'start',
        input: { path: input.path },
      }),
    );

    try {
      const exists = await layers.WithFileSystemLayer.fileExists(input.path);
      const output = { path: input.path, exists };
      emit(
        ToolUsedEvent.make({
          toolCallId,
          toolName: 'fileExists',
          phase: 'end',
          output,
        }),
      );
      return output;
    } catch (error) {
      emit(
        ToolUsedEvent.make({
          toolCallId,
          toolName: 'fileExists',
          phase: 'end',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  });

export const fileSystemTools = [
  listDirectoryTool,
  readTextFileTool,
  writeTextFileTool,
  fileExistsTool,
];
