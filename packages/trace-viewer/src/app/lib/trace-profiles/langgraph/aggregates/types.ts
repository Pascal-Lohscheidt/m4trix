export type TokenRollup = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type RunSubtreeRollup = TokenRollup & {
  costUsd: number;
  hasUsage: boolean;
};

export type ExtractedUsage = Partial<TokenRollup> & {
  costUsd?: number;
};

export type MetadataUsage = {
  tokens?: Partial<TokenRollup>;
  costUsd?: number;
};
