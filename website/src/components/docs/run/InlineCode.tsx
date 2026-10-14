import { Fragment } from 'react';

/** Renders a walkthrough sentence: text with `backticked` names as inline code. */
export function InlineCode({ text }: { text: string }) {
  const parts = text.split('`');
  return (
    <>
      {parts.map((part, i) =>
        // Odd parts sit between backticks. An unpaired trailing backtick stays text.
        i % 2 === 1 && i < parts.length - 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <code key={i}>{part}</code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <Fragment key={i}>{i % 2 === 1 ? `\`${part}` : part}</Fragment>
        ),
      )}
    </>
  );
}
