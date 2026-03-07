/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Utility types to extract paths and values from nested prompt dictionaries
 */

/**
 * All valid nested paths in T, represented as strings like "key1/key2" or just "key".
 */
type Path<T> = T extends string
  ? never
  : {
      [K in Extract<keyof T, string>]: T[K] extends string
        ? K
        : T[K] extends Record<string, any>
          ? K | `${K}/${Path<T[K]>}`
          : never;
    }[Extract<keyof T, string>];

/**
 * Value at a nested path P in T. E.g. PathValue<{a:{b:string}}, "a/b"> => string
 */
type PathValue<T, P extends string> = P extends `${infer Key}/${infer Rest}`
  ? Key extends keyof T
    ? PathValue<T[Key], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

/**
 * Prompt dictionary with optional locale-based nested prompts.
 */
export class PromptDictionary<T extends Record<string, any>> {
  private data: T;

  private constructor(data: T) {
    this.data = data;
  }

  /**
   * Create a PromptDictionary from a raw JSON object.
   */
  static fromJSON<D extends Record<string, unknown>>(
    data: D
  ): PromptDictionary<D> {
    return new PromptDictionary<D>(data);
  }

  /**
   * Placeholder for cloud-fetch logic.
   */
  async pullFromCloud(): Promise<void> {
    // TODO: Implement fetching logic
    return Promise.resolve();
  }

  /**
   * Retrieve a prompt or locale-specific sub-object by its path.
   * @param path - Nested path like "greeting/hello"
   * @param locale - Optional locale key if the target is an object of locales.
   */
  get<P extends Path<T>>(
    path: P,
    locale: string = 'en'
  ): PathValue<T, P> | string | undefined {
    const segments = (path as string).split('/');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any = this.data;
    for (const seg of segments) {
      result = result?.[seg];
      if (result === undefined) {
        return undefined;
      }
    }
    // If this value is an object and locale provided, pull that:
    if (typeof result === 'object' && locale) {
      return result[locale] as string;
    }
    return result;
  }

  /**
   * Create a sub-dictionary rooted at the given path.
   * @param prefix - Path of the sub-tree
   */
  sub<P extends Path<T>>(prefix: P): PromptDictionary<PathValue<T, P>> {
    const sub = this.get(prefix);
    if (!sub || typeof sub !== 'object') {
      throw new Error(`Sub-path '${prefix}' does not resolve to an object.`);
    }
    return new PromptDictionary(sub as PathValue<T, P>);
  }
}
