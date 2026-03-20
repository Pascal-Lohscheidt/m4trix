/**
 * Map from each tag literal to a `string` value (the same string at runtime).
 * Lets you reference `set['my-tag']` with autocomplete and errors on unknown keys.
 */
export type TagSetMembers<T extends readonly string[]> = {
  readonly [K in T[number]]: string;
};

/**
 * Closed set of tag strings for type-safe references (`set['alpha']` is valid; `set['nope']` is a type error).
 * Values are plain `string`, so they assign to `string[]`, dataset matchers, etc.
 */
export class TagSet {
  private constructor() {}

  static define<const T extends readonly string[]>(tags: T): TagSetMembers<T> {
    const out: Record<string, string> = {};
    for (const tag of tags) {
      out[tag] = tag;
    }
    return out as TagSetMembers<T>;
  }
}
