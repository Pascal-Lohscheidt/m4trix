import type { CollectedTestCase, SearchTestCasesQuery } from './events';

function matchesAny(
  value: string,
  matchers: ReadonlyArray<string | RegExp> | undefined,
): boolean {
  if (!matchers || matchers.length === 0) {
    return true;
  }
  return matchers.some((matcher) =>
    typeof matcher === 'string' ? matcher === value : matcher.test(value),
  );
}

function matchesPath(
  value: string,
  matchers: ReadonlyArray<string | RegExp> | undefined,
): boolean {
  if (!matchers || matchers.length === 0) {
    return true;
  }
  return matchers.some((matcher) => {
    if (typeof matcher === 'string') {
      return value.includes(matcher);
    }
    return matcher.test(value);
  });
}

export function searchCollectedTestCases(
  all: ReadonlyArray<CollectedTestCase>,
  query?: SearchTestCasesQuery,
): ReadonlyArray<CollectedTestCase> {
  if (!query) {
    return all;
  }

  return all.filter((item) => {
    const tags = item.testCase.getTags();

    if (
      query.excludedTags &&
      tags.some((tag) => matchesAny(tag, query.excludedTags))
    ) {
      return false;
    }
    if (
      query.excludedPaths &&
      matchesPath(item.filePath, query.excludedPaths)
    ) {
      return false;
    }

    const includedTagsMatch =
      !query.includedTags ||
      query.includedTags.length === 0 ||
      tags.some((tag) => matchesAny(tag, query.includedTags));

    const includedPathsMatch =
      !query.includedPaths ||
      query.includedPaths.length === 0 ||
      matchesPath(item.filePath, query.includedPaths);

    return includedTagsMatch && includedPathsMatch;
  });
}
