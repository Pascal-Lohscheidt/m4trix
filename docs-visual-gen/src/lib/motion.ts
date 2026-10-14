/**
 * The slice of an anime.js v4 `Timeline` the motion helpers use. Typed structurally so a
 * timeline from any anime.js 4.x install (the website pins its own) can be passed in, and
 * so the lib has no runtime dependency on anime.js.
 */
export interface TimelineLike {
  add(targets: string, parameters: Record<string, unknown>, position?: number): TimelineLike;
}
