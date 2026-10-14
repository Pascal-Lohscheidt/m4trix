'use client';

import {
  CaretDownIcon,
  CheckIcon,
  CodeIcon,
  CopyIcon,
  type Icon,
  LinkSimpleIcon,
  MarkdownLogoIcon,
  OpenAiLogoIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { siClaude, siCursor } from 'simple-icons';
import { BrandIcon } from '@/components/BrandIcon';
import { MCP_SERVER_NAME, MCP_URL } from '@/lib/docs/site';

type SimpleIcon = typeof siCursor;

interface Action {
  id: string;
  label: string;
  hint: string;
  icon: Icon | SimpleIcon;
  /** Either a link (opened in a new tab) or something to copy. */
  href?: string;
  copy?: () => Promise<string>;
  external?: boolean;
}

const CLAUDE_CODE_COMMAND = `claude mcp add --transport http ${MCP_SERVER_NAME} ${MCP_URL}`;

function cursorInstallUrl(): string {
  const config = btoa(JSON.stringify({ url: MCP_URL }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_SERVER_NAME}&config=${config}`;
}

function vscodeInstallUrl(): string {
  return `vscode:mcp/install?${encodeURIComponent(
    JSON.stringify({ name: MCP_SERVER_NAME, type: 'http', url: MCP_URL }),
  )}`;
}

/**
 * Writes text that may still be loading. ClipboardItem accepts a promise, which keeps the
 * click's user activation alive while the Markdown is fetched (required by Safari).
 */
async function copyToClipboard(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': text.then((value) => new Blob([value], { type: 'text/plain' })),
        }),
      ]);
      return;
    } catch {
      // Fall through to writeText (e.g. browsers without promise support in ClipboardItem).
    }
  }
  await navigator.clipboard.writeText(await text);
}

function askPrompt(markdownUrl: string): string {
  return `Read ${markdownUrl} so I can ask questions about it.`;
}

function ActionIcon({ icon }: { icon: Icon | SimpleIcon }) {
  if ('path' in icon) return <BrandIcon icon={icon} className="h-3.5 w-3.5" />;
  const Component = icon;
  return <Component aria-hidden className="h-4 w-4" />;
}

/**
 * "Copy page" split button with the LLM / MCP actions Mintlify had, plus Claude, ChatGPT and
 * VS Code. Markdown comes from the page's `.md` route, so copies match what agents fetch.
 */
export function PageActions({
  markdownPath,
  markdownUrl,
}: {
  /** Same-origin path used for fetching, e.g. `/docs/concepts/events.md`. */
  markdownPath: string;
  /** Public URL handed to external assistants. */
  markdownUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  // Cached per page and warmed on hover, so "Copy page" is instant.
  const markdownRef = useRef<Promise<string> | null>(null);
  const fetchMarkdown = useCallback(() => {
    markdownRef.current ??= fetch(markdownPath).then((response) => {
      if (!response.ok) throw new Error(`Could not load ${markdownPath}`);
      return response.text();
    });
    markdownRef.current.catch(() => {
      markdownRef.current = null;
    });
    return markdownRef.current;
  }, [markdownPath]);

  const actions: Action[][] = [
    [
      {
        id: 'copy',
        label: 'Copy page',
        hint: 'Copy this page as Markdown for LLMs',
        icon: CopyIcon,
        copy: fetchMarkdown,
      },
      {
        id: 'markdown',
        label: 'View as Markdown',
        hint: 'Open the plain-text version',
        icon: MarkdownLogoIcon,
        href: markdownPath,
      },
      {
        id: 'claude',
        label: 'Open in Claude',
        hint: 'Ask Claude about this page',
        icon: siClaude,
        href: `https://claude.ai/new?q=${encodeURIComponent(askPrompt(markdownUrl))}`,
        external: true,
      },
      {
        id: 'chatgpt',
        label: 'Open in ChatGPT',
        hint: 'Ask ChatGPT about this page',
        icon: OpenAiLogoIcon,
        href: `https://chatgpt.com/?hints=search&q=${encodeURIComponent(askPrompt(markdownUrl))}`,
        external: true,
      },
    ],
    [
      {
        id: 'cursor',
        label: 'Connect to Cursor',
        hint: 'Install the docs MCP server in Cursor',
        icon: siCursor,
        href: cursorInstallUrl(),
        external: true,
      },
      {
        id: 'vscode',
        label: 'Connect to VS Code',
        hint: 'Install the docs MCP server in VS Code',
        icon: CodeIcon,
        href: vscodeInstallUrl(),
        external: true,
      },
      {
        id: 'claude-code',
        label: 'Copy Claude Code command',
        hint: 'claude mcp add … for the docs MCP server',
        icon: TerminalWindowIcon,
        copy: async () => CLAUDE_CODE_COMMAND,
      },
      {
        id: 'mcp-url',
        label: 'Copy MCP server URL',
        hint: MCP_URL.replace(/^https?:\/\//, ''),
        icon: LinkSimpleIcon,
        copy: async () => MCP_URL,
      },
    ],
  ];
  const flat = actions.flat();

  const run = async (action: Action) => {
    if (action.copy) {
      await copyToClipboard(action.copy());
      setDone(action.id);
    }
    setOpen(false);
  };

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(null), 1800);
    return () => clearTimeout(timer);
  }, [done]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    itemRefs.current[0]?.focus();
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const onMenuKey = (event: React.KeyboardEvent) => {
    const items = itemRefs.current.filter((el): el is HTMLElement => el !== null);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      setOpen(false);
      rootRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    }
  };

  let itemIndex = -1;

  return (
    <div ref={rootRef} className="relative inline-flex">
      <div className="docs-split">
        <button
          type="button"
          className="docs-split-main"
          onPointerEnter={() => void fetchMarkdown()}
          onFocus={() => void fetchMarkdown()}
          onClick={() => run(flat[0])}
          aria-label="Copy page as Markdown"
        >
          {done === 'copy' ? (
            <CheckIcon aria-hidden className="h-3.5 w-3.5" style={{ color: 'var(--green)' }} />
          ) : (
            <CopyIcon aria-hidden className="h-3.5 w-3.5" />
          )}
          {done === 'copy' ? 'Copied' : 'Copy page'}
        </button>
        <button
          type="button"
          className="docs-split-toggle"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label="More page actions"
          onClick={() => setOpen((value) => !value)}
        >
          <CaretDownIcon
            aria-hidden
            className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Page actions"
          className="docs-menu glass"
          onKeyDown={onMenuKey}
        >
          {actions.map((section, sectionIndex) => (
            <div
              key={section[0].id}
              role="none"
              className={sectionIndex ? 'docs-menu-section' : ''}
            >
              {section.map((action) => {
                itemIndex += 1;
                const position = itemIndex;
                const content = (
                  <>
                    <span className="docs-menu-icon">
                      <ActionIcon icon={action.icon} />
                    </span>
                    <span className="min-w-0">
                      <span className="docs-menu-label">
                        {done === action.id ? 'Copied' : action.label}
                        {action.external ? <span aria-hidden> ↗</span> : null}
                      </span>
                      <span className="docs-menu-hint">{action.hint}</span>
                    </span>
                  </>
                );
                return action.href ? (
                  <a
                    key={action.id}
                    ref={(el) => {
                      itemRefs.current[position] = el;
                    }}
                    role="menuitem"
                    href={action.href}
                    target="_blank"
                    rel="noreferrer"
                    className="docs-menu-item"
                    onClick={() => setOpen(false)}
                  >
                    {content}
                  </a>
                ) : (
                  <button
                    key={action.id}
                    ref={(el) => {
                      itemRefs.current[position] = el;
                    }}
                    type="button"
                    role="menuitem"
                    className="docs-menu-item"
                    onClick={() => run(action)}
                  >
                    {content}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {done ? 'Copied to clipboard' : ''}
      </span>
    </div>
  );
}
