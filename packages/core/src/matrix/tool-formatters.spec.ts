import { type Schema as AiSchema, asSchema, jsonSchema, type ToolSet } from 'ai';
import { Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { AgentToolCollection, Tool } from './tool.js';
import { ToolDefinitionError } from './tool-errors.js';
import {
  type AiSdkTool,
  type AnthropicTool,
  type OpenAIFunctionTool,
  type ToolJsonSchema,
  toAiSdkTools,
  toAnthropicTools,
  toOpenAITools,
} from './tool-formatters.js';

const defineWithInput = <I extends S.Schema.Any>(input: I, name = 'probe') =>
  Tool.of({ name, description: `${name} tool` })
    .input(input)
    .output(S.Struct({ ok: S.Boolean }))
    .define(() => ({ ok: true }));

describe('tool JSON Schema', () => {
  test('struct with descriptions, optional fields and arrays', () => {
    const tool = Tool.of({ name: 'search', description: 'Search the web' })
      .input(
        S.Struct({
          query: S.String.annotations({ description: 'Search query' }),
          limit: S.optional(S.Number),
          tags: S.Array(S.String),
        }).annotations({ description: 'Search arguments' }),
      )
      .output(S.Struct({ hits: S.Number }))
      .define(() => ({ hits: 0 }));

    expect(tool.toJsonSchema()).toEqual({
      name: 'search',
      description: 'Search the web',
      parameters: {
        type: 'object',
        description: 'Search arguments',
        required: ['query', 'tags'],
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    });
  });

  test('literals and enums become JSON Schema enums', () => {
    const tool = defineWithInput(
      S.Struct({
        order: S.Literal('asc', 'desc'),
        level: S.Enums({ Low: 'low', High: 'high' }),
      }),
    );

    expect(tool.toJsonSchema().parameters.properties).toEqual({
      order: { type: 'string', enum: ['asc', 'desc'] },
      level: {
        anyOf: [
          { type: 'string', title: 'Low', enum: ['low'] },
          { type: 'string', title: 'High', enum: ['high'] },
        ],
      },
    });
  });

  test('strips $schema and inlines $ref/$defs of nested identified structs', () => {
    const Address = S.Struct({ city: S.String }).annotations({
      identifier: 'Address',
      description: 'Postal address',
    });
    const tool = defineWithInput(
      S.Struct({ home: Address, work: S.optional(Address), count: S.NumberFromString }),
    );
    const { parameters } = tool.toJsonSchema();

    expect(parameters).not.toHaveProperty('$schema');
    expect(parameters).not.toHaveProperty('$defs');
    expect(JSON.stringify(parameters)).not.toContain('$ref');
    expect(parameters.properties).toEqual({
      home: {
        type: 'object',
        description: 'Postal address',
        required: ['city'],
        properties: { city: { type: 'string' } },
        additionalProperties: false,
      },
      work: {
        type: 'object',
        description: 'Postal address',
        required: ['city'],
        properties: { city: { type: 'string' } },
        additionalProperties: false,
      },
      // Transformations are described by their encoded (wire) side, which is what a model sends.
      count: { type: 'string', description: 'a string to be decoded into a number' },
    });
  });

  test('inlines a root $ref so the parameters are a plain object schema', () => {
    const tool = defineWithInput(S.Struct({ id: S.String }).annotations({ identifier: 'Root' }));

    expect(tool.toJsonSchema().parameters).toEqual({
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
      additionalProperties: false,
    });
  });

  test('keeps $defs only for recursive schemas', () => {
    interface Category {
      readonly name: string;
      readonly children: ReadonlyArray<Category>;
    }
    const Category: S.Schema<Category> = S.Struct({
      name: S.String,
      children: S.Array(S.suspend((): S.Schema<Category> => Category)),
    }).annotations({ identifier: 'Category' });
    const tool = defineWithInput(S.Struct({ root: Category, label: S.String }));

    expect(tool.toJsonSchema().parameters).toEqual({
      type: 'object',
      required: ['root', 'label'],
      properties: { root: { $ref: '#/$defs/Category' }, label: { type: 'string' } },
      additionalProperties: false,
      $defs: {
        Category: {
          type: 'object',
          required: ['name', 'children'],
          properties: {
            name: { type: 'string' },
            children: { type: 'array', items: { $ref: '#/$defs/Category' } },
          },
          additionalProperties: false,
        },
      },
    });
  });

  test('throws ToolDefinitionError at define() for schemas without a JSON Schema', () => {
    const define = () => defineWithInput(S.Struct({ at: S.DateFromSelf }), 'schedule');

    expect(define).toThrow(ToolDefinitionError);
    expect(define).toThrow(/Tool "schedule": input schema cannot be converted to JSON Schema/);
  });

  test('throws ToolDefinitionError at define() for non-object input schemas', () => {
    expect(() => defineWithInput(S.String, 'plain')).toThrow(ToolDefinitionError);
    expect(() => defineWithInput(S.String, 'plain')).toThrow(
      /Tool "plain": input schema must be an object schema/,
    );
    expect(() =>
      defineWithInput(S.Union(S.Struct({ a: S.String }), S.Struct({ b: S.Number })), 'either'),
    ).toThrow(/Tool "either": input schema must be an object schema/);
  });

  test('AgentToolCollection#toJsonSchemas lists every tool', () => {
    const a = defineWithInput(S.Struct({ a: S.String }), 'toolA');
    const b = defineWithInput(S.Struct({}), 'toolB');
    const collection = new AgentToolCollection([a, b], {}, () => {});

    expect(collection.toJsonSchemas()).toEqual([a.toJsonSchema(), b.toJsonSchema()]);
    expect(collection.toJsonSchemas()[1]).toEqual({
      name: 'toolB',
      description: 'toolB tool',
      parameters: { type: 'object', required: [], properties: {}, additionalProperties: false },
    });
    expectTypeOf(collection.toJsonSchemas()).toEqualTypeOf<ReadonlyArray<ToolJsonSchema>>();
    expectTypeOf(a.toJsonSchema()).toEqualTypeOf<ToolJsonSchema>();
  });
});

describe('provider formatters', () => {
  const weather = Tool.of({ name: 'getWeather', description: 'Current weather for a city' })
    .input(S.Struct({ city: S.String.annotations({ description: 'City name' }) }))
    .output(S.Struct({ celsius: S.Number }))
    .define(({ input }) => ({ celsius: input.city.length }));
  const parameters = {
    type: 'object',
    required: ['city'],
    properties: { city: { type: 'string', description: 'City name' } },
    additionalProperties: false,
  };
  const collection = new AgentToolCollection([weather], {}, () => {});

  test('toOpenAI produces Chat Completions function tools', () => {
    const expected = [
      {
        type: 'function',
        function: { name: 'getWeather', description: 'Current weather for a city', parameters },
      },
    ];
    expect(collection.toOpenAI()).toEqual(expected);
    expect(toOpenAITools([weather])).toEqual(expected);
    expectTypeOf(collection.toOpenAI()).toEqualTypeOf<Array<OpenAIFunctionTool>>();
    expectTypeOf(toOpenAITools([weather])).toEqualTypeOf<Array<OpenAIFunctionTool>>();
  });

  test('toAnthropic produces Messages API custom tools', () => {
    const expected = [
      { name: 'getWeather', description: 'Current weather for a city', input_schema: parameters },
    ];
    expect(collection.toAnthropic()).toEqual(expected);
    expect(toAnthropicTools([weather])).toEqual(expected);
    expectTypeOf(collection.toAnthropic()).toEqualTypeOf<Array<AnthropicTool>>();
  });

  test('formatters return fresh copies callers may mutate', () => {
    const [first] = collection.toOpenAI();
    if (first) first.function.parameters.required = [];
    expect(collection.toOpenAI()[0]?.function.parameters.required).toEqual(['city']);
  });

  test('toAiSdk produces an AI SDK v5 ToolSet keyed by tool name', async () => {
    const tools = collection.toAiSdk({ jsonSchema });
    const toolSet: ToolSet = tools;

    expect(Object.keys(toolSet)).toEqual(['getWeather']);
    const tool = tools.getWeather as AiSdkTool<AiSchema<unknown>>;
    expect(tool.description).toBe('Current weather for a city');
    expect(asSchema(tool.inputSchema).jsonSchema).toEqual(parameters);
    await expect(tool.execute({ city: 'Paris' }, { toolCallId: 'call-1' })).resolves.toEqual({
      celsius: 5,
    });
    expectTypeOf(tools).toEqualTypeOf<Record<string, AiSdkTool<AiSchema<unknown>>>>();
    expect(Object.keys(toAiSdkTools(collection.toTools(), { jsonSchema }))).toEqual(['getWeather']);
  });

  test('toAiSdk execute forwards the AI SDK toolCallId and abortSignal to the tool', async () => {
    const controller = new AbortController();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe = Tool.of({ name: 'probe', description: 'Records its call' })
      .input(S.Struct({}))
      .output(S.Struct({ toolCallId: S.String, abortedBefore: S.Boolean, abortedAfter: S.Boolean }))
      .define(async ({ toolCallId, signal }) => {
        const abortedBefore = signal.aborted;
        await gate;
        return { toolCallId, abortedBefore, abortedAfter: signal.aborted };
      });
    const tools = new AgentToolCollection([probe], {}, () => {}).toAiSdk({ jsonSchema });

    const pending = tools.probe?.execute(
      {},
      { toolCallId: 'call-7', abortSignal: controller.signal },
    );
    controller.abort();
    release();

    await expect(pending).resolves.toEqual({
      toolCallId: 'call-7',
      abortedBefore: false,
      abortedAfter: true,
    });
  });

  test('toAiSdk execute rejects with the typed tool error the AI SDK feeds back to the model', async () => {
    const tools = collection.toAiSdk({ jsonSchema });
    await expect(
      tools.getWeather?.execute({ city: 42 }, { toolCallId: 'call-2' }),
    ).rejects.toMatchObject({ _tag: 'ToolInputError' });
  });
});
