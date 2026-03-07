import { Brand } from 'effect';

/** Regex: lowercase alphanumeric segments separated by hyphens (e.g. my-channel-name) */
const KEBAB_CASE_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Branded type for channel names. Enforces kebab-case at runtime via refinement.
 *
 * **Branded types** add a nominal marker so TypeScript treats `ChannelName` as
 * distinct from plain `string`, preventing accidental substitution (e.g. passing
 * a raw string where a validated channel name is expected).
 *
 * **Refinement** validates at runtime that the value matches kebab-case before
 * the brand is applied. Use `ChannelName(value)` to create a validated instance.
 */
export type ChannelName = string & Brand.Brand<'ChannelName'>;

export const ChannelName = Brand.refined<ChannelName>(
  (s) => typeof s === 'string' && KEBAB_CASE_REGEX.test(s),
  (s) => Brand.error(`Expected kebab-case (e.g. my-channel-name), got: ${s}`),
);
