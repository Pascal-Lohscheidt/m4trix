export function parseRegexLiteral(pattern: string): { source: string; flags: string } | undefined {
  if (!pattern.startsWith('/')) {
    return undefined;
  }
  const lastSlash = pattern.lastIndexOf('/');
  if (lastSlash <= 0) {
    return undefined;
  }
  return {
    source: pattern.slice(1, lastSlash),
    flags: pattern.slice(lastSlash + 1),
  };
}

/** Same matching rules as `RunnerApi.resolveEvaluatorsByNamePattern` (RunConfig `evaluatorPattern`, etc.). */
export function createNameMatcher(pattern: string): (value: string) => boolean {
  const normalizedPattern = pattern.trim();
  const regexLiteral = parseRegexLiteral(normalizedPattern);
  if (regexLiteral) {
    const regex = new RegExp(regexLiteral.source, regexLiteral.flags);
    return (value: string) => regex.test(value);
  }

  if (normalizedPattern.includes('*')) {
    const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(`^${escaped}$`, 'i');
    return (value: string) => regex.test(value);
  }

  return (value: string) => value.toLowerCase() === normalizedPattern.toLowerCase();
}
