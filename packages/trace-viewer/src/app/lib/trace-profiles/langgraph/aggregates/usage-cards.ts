import type { ProfileAggregates } from '../../types';
import type { TokenRollup } from './types';

/** Header aggregate cards for a trace-wide token / cost rollup. */
export function buildUsageAggregateCards(input: {
  rollup: TokenRollup;
  costUsdReported: number;
  costUsdEstimated: number;
  spansWithUsage: number;
}): ProfileAggregates['cards'] {
  const { rollup, costUsdReported, costUsdEstimated, spansWithUsage } = input;
  const cards: ProfileAggregates['cards'] = [];
  if (rollup.totalTokens > 0 || rollup.promptTokens > 0 || rollup.completionTokens > 0) {
    cards.push({
      id: 'tokens-total',
      label: 'Tokens (total est.)',
      value: String(rollup.totalTokens || rollup.promptTokens + rollup.completionTokens),
    });
    if (rollup.promptTokens > 0) {
      cards.push({
        id: 'tokens-prompt',
        label: 'Prompt tokens',
        value: String(rollup.promptTokens),
      });
    }
    if (rollup.completionTokens > 0) {
      cards.push({
        id: 'tokens-completion',
        label: 'Completion tokens',
        value: String(rollup.completionTokens),
      });
    }
  }
  if (costUsdReported > 0) {
    cards.push({
      id: 'cost-usd-reported',
      label: 'Reported cost (USD)',
      value: costUsdReported.toFixed(6),
    });
  }
  if (costUsdEstimated > 0) {
    cards.push({
      id: 'cost-usd-estimated',
      label: 'Estimated cost (USD)',
      value: `~${costUsdEstimated.toFixed(6)}`,
    });
  }
  if (cards.length === 0 && spansWithUsage === 0) {
    cards.push({
      id: 'no-usage',
      label: 'Usage',
      value: 'No token or cost fields found in loaded payloads.',
    });
  }
  return cards;
}
