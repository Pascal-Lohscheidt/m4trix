import { Effect, Console } from 'effect';
import { ChatPrompt } from './formattables/Prompt';

// ========================
// PROVIDER TYPES
// ========================

enum KnownProviders {
  OPENAI = 'OPEN_AI',
  ANTHROPIC = 'ANTHROPIC',
  GOOGLE = 'GOOGLE',
  AZURE = 'AZURE',
  CLAUDE = 'CLAUDE',
  GROQ = 'GROQ',
  OLLAMA = 'OLLAMA',
  CUSTOM = 'CUSTOM',
}

interface ProviderConfig {
  name: KnownProviders;
  endpointConfig?: string;
  apiKey: string;
}

// ========================
// MODEL TYPES AND TIERS
// ========================

// To be double checked
enum Models {
  // OpenAI
  GPT_4O = 'gpt-4o',
  GPT_4O_MINI = 'gpt-4o-mini',
  GPT_4 = 'gpt-4',
  GPT_4_TURBO = 'gpt-4-turbo',
  GPT_3_5_TURBO = 'gpt-3.5-turbo',
  GPT_3_5_TURBO_16K = 'gpt-3.5-turbo-16k',

  // Anthropic Claude
  CLAUDE_3_5_SONNET = 'claude-3-5-sonnet-20241022',
  CLAUDE_3_OPUS = 'claude-3-opus-20240229',
  CLAUDE_3_SONNET = 'claude-3-sonnet-20240229',
  CLAUDE_3_HAIKU = 'claude-3-haiku-20240307',
  CLAUDE_2_1 = 'claude-2.1',
  CLAUDE_2_0 = 'claude-2.0',
  CLAUDE_INSTANT_1_2 = 'claude-instant-1.2',

  // Google Gemini
  GEMINI_1_5_PRO = 'gemini-1.5-pro',
  GEMINI_1_5_FLASH = 'gemini-1.5-flash',
  GEMINI_PRO = 'gemini-pro',
  GEMINI_PRO_VISION = 'gemini-pro-vision',

  // Groq
  LLAMA_3_8B = 'llama-3-8b',
  LLAMA_3_70B = 'llama-3-70b',
  MIXTRAL_8X7B = 'mixtral-8x7b',
  GEMMA_7B = 'gemma-7b',

  // Ollama
  LLAMA3_8B_OLLAMA = 'llama3:8b',
  LLAMA3_70B_OLLAMA = 'llama3:70b',
  MISTRAL_7B_OLLAMA = 'mistral:7b',
  MIXTRAL_8X7B_OLLAMA = 'mixtral:8x7b',
  PHI3_3B_OLLAMA = 'phi3:3b',
  GEMMA_2B_OLLAMA = 'gemma:2b',
  GEMMA_7B_OLLAMA = 'gemma:7b',

  // Azure (OpenAI compatible, but can be custom deployment names)
  AZURE_GPT_4 = 'azure-gpt-4',
  AZURE_GPT_35_TURBO = 'azure-gpt-35-turbo',

  // Custom/Other
  CUSTOM = 'custom',
}

interface ModelConfig {
  provider: ProviderConfig;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

// ========================
// LLM RESPONSE TYPE
// ========================

export interface LLMResponse {
  content: string;
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  finishReason?: string;
}

// ========================
// LLM CONFIGURATION
// ========================

export interface LLMConfig {
  models: ModelConfig[] | string | ModelConfig;
  iterateOnFail?: boolean;
  maxRetries?: number;
  retryDelay?: number;
}

// ========================
// MODEL ADAPTER INTERFACE
// ========================

interface ModelAdapter {
  chat(
    prompt: ChatPrompt,
    config: ModelConfig
  ): Effect.Effect<LLMResponse, Error>;
  run(prompt: string, config: ModelConfig): Effect.Effect<LLMResponse, Error>;
}

// ========================
// MAIN LLM CLASS
// ========================

export class LLM {
  private models: ModelConfig[];
  private iterateOnFail: boolean;
  private maxRetries: number;
  private retryDelay: number;
  private adapter: ModelAdapter;

  constructor(config: LLMConfig) {
    this.models = this.normalizeModels(config.models);
    this.iterateOnFail = config.iterateOnFail ?? true;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
    this.adapter = new MockModelAdapter(); // In production, this would be a real adapter
  }

  private normalizeModels(models: LLMConfig['models']): ModelConfig[] {
    if (typeof models === 'string') {
      // Check if it's a ModelTier first
      if (Object.values(ModelTier).includes(models as ModelTier)) {
        return MODEL_CONFIGS[models as ModelTier];
      }
      // Otherwise treat as model name
      return [
        {
          provider: {
            name: KnownProviders.OPENAI,
            apiKey: process.env.OPENAI_API_KEY || '',
          },
          model: models,
        },
      ];
    }

    if (Array.isArray(models)) {
      return models;
    }

    return [models];
  }

  private attemptWithModel(
    modelConfig: ModelConfig,
    operation: (config: ModelConfig) => Effect.Effect<LLMResponse, Error>
  ): Effect.Effect<LLMResponse, Error> {
    return Effect.gen(function* () {
      try {
        const result = yield* operation(modelConfig);
        yield* Console.log(`✅ Success with model: ${modelConfig.model}`);
        return result;
      } catch (error) {
        yield* Console.log(
          `❌ Failed with model: ${modelConfig.model}, error: ${error}`
        );
        return yield* Effect.fail(error as Error);
      }
    });
  }

  private executeWithFallback(
    operation: (config: ModelConfig) => Effect.Effect<LLMResponse, Error>
  ): Effect.Effect<LLMResponse, Error> {
    if (!this.iterateOnFail || this.models.length === 1) {
      return operation(this.models[0]);
    }

    const models = this.models;
    return Effect.gen(function* () {
      let lastError: Error | null = null;

      for (const modelConfig of models) {
        try {
          return yield* operation(modelConfig);
        } catch (error) {
          lastError = error as Error;
          continue;
        }
      }

      return yield* Effect.fail(lastError || new Error('All models failed'));
    });
  }

  chat(prompt: ChatPrompt): Effect.Effect<LLMResponse, Error> {
    return this.executeWithFallback((config) =>
      this.adapter.chat(prompt, config)
    );
  }

  run(prompt: string): Effect.Effect<LLMResponse, Error> {
    return this.executeWithFallback((config) =>
      this.adapter.run(prompt, config)
    );
  }

  // ========================
  // STATIC FACTORY METHODS
  // ========================

  static get(config: LLMConfig): LLM {
    return new LLM(config);
  }
}

// ========================
// EXPORTS
// ========================

export {
  KnownProviders,
  Models,
  ModelTier,
  type ProviderConfig,
  type ModelConfig,
};
