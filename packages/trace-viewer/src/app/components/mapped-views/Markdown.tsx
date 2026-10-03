import { type ReactNode, useMemo } from 'react';
import { type MarkdownInline, parseMarkdown } from '../../lib/payload-mapper/markdown';

function Inlines({ inlines }: { inlines: MarkdownInline[] }): ReactNode {
  return inlines.map((node, i) => {
    const key = `${i}-${node.type}`;
    switch (node.type) {
      case 'code':
        return (
          <code
            key={key}
            className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[11px] text-amber-200"
          >
            {node.text}
          </code>
        );
      case 'bold':
        return (
          <strong key={key} className="font-semibold text-zinc-100">
            {node.text}
          </strong>
        );
      case 'italic':
        return <em key={key}>{node.text}</em>;
      case 'link':
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-sky-300 underline decoration-sky-300/40 hover:decoration-sky-300"
          >
            {node.text}
          </a>
        );
      default:
        return <span key={key}>{node.text}</span>;
    }
  });
}

const HEADING_CLASS = ['', 'text-base', 'text-sm', 'text-sm', 'text-xs', 'text-xs', 'text-xs'];

export function Markdown({ source }: { source: string }): ReactNode {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="space-y-2 text-[13px] leading-relaxed text-zinc-300">
      {blocks.map((block, i) => {
        const key = `${i}-${block.type}`;
        switch (block.type) {
          case 'heading':
            return (
              <div
                key={key}
                className={`font-semibold text-zinc-100 ${HEADING_CLASS[block.level]}`}
              >
                <Inlines inlines={block.inlines} />
              </div>
            );
          case 'code':
            return (
              <pre
                key={key}
                className="m-0 max-h-80 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] text-zinc-200"
              >
                {block.text}
              </pre>
            );
          case 'list': {
            const ListTag = block.ordered ? 'ol' : 'ul';
            return (
              <ListTag
                key={key}
                className={`m-0 space-y-0.5 pl-5 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
              >
                {block.items.map((item, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static parsed content
                  <li key={j}>
                    <Inlines inlines={item} />
                  </li>
                ))}
              </ListTag>
            );
          }
          case 'quote':
            return (
              <blockquote
                key={key}
                className="m-0 whitespace-pre-wrap border-l-2 border-zinc-700 pl-3 text-zinc-400"
              >
                <Inlines inlines={block.inlines} />
              </blockquote>
            );
          case 'rule':
            return <hr key={key} className="border-zinc-800" />;
          default:
            return (
              <p key={key} className="m-0 whitespace-pre-wrap break-words">
                <Inlines inlines={block.inlines} />
              </p>
            );
        }
      })}
    </div>
  );
}
