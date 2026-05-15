export type TokenRollup = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type RunSubtreeRollup = TokenRollup & {
  /** Reported + estimated (display total). */
  costUsd: number;
  costUsdReported: number;
  costUsdEstimated: number;
  /** Set when cost was derived from `MODEL_PRICING_USD_PER_1M`. */
  estimatedModel?: string;
  hasUsage: boolean;
};

export type ExtractedUsage = Partial<TokenRollup> & {
  costUsd?: number;
};

export type MetadataUsage = {
  tokens?: Partial<TokenRollup>;
  costUsd?: number;
};
