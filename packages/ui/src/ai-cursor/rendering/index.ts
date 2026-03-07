import './AiCursorComponent';
import { AiCursorComponent, Props as AiCursorProps } from './AiCursorComponent';
/**
 * The AI Cursor is a Lit Element.
 * Why Lit.dev?
 * Lit.dev is a tiny on memory and bundle size. It is quite fast in rendering.
 * And since UI elements in this library shall be isolated and scoped components,
 * Lit.dev is a good fit.
 * It follows reactivity principles with very fine granularity,
 *
 * Also Solid.js (which was the first version of that - prooved to be annoying because of jsx compiler extras).
 *
 * A downside of Lit.dev is that it is not a very common library. Further, it is close to the DOM using native DOM APIs.
 * Causing it to be a bit different than libs like react using virtual DOM.
 * For other contributors I would recommend reading the /life-cycle section of the docs.
 *
 * Author: @Pascal-Lohscheidt
 */
export const mountAiCursor = (aiCursorProps: AiCursorProps): void => {
  const root = document.body;
  const cursor = document.createElement('ai-cursor') as AiCursorComponent;
  cursor.eventHooks = aiCursorProps.eventHooks;

  root.appendChild(cursor);
};
