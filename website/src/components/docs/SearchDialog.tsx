'use client';

import { FileTextIcon, HashIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { excerpt, type SearchRecord, searchRecords } from '@/lib/docs/search-core';

let indexPromise: Promise<SearchRecord[]> | undefined;

function loadIndex(): Promise<SearchRecord[]> {
  indexPromise ??= fetch('/docs/search.json')
    .then((response) => response.json() as Promise<SearchRecord[]>)
    .catch((error) => {
      indexPromise = undefined;
      throw error;
    });
  return indexPromise;
}

export function SearchButton({
  onOpen,
  compact = false,
}: {
  onOpen: () => void;
  compact?: boolean;
}) {
  const [mac, setMac] = useState(true);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);

  if (compact) {
    return (
      <button
        type="button"
        className="docs-icon-btn docs-icon-btn-lg"
        aria-label="Search docs"
        onClick={onOpen}
      >
        <MagnifyingGlassIcon aria-hidden className="h-4 w-4" />
      </button>
    );
  }
  return (
    <button type="button" className="docs-search-btn" onClick={onOpen} onMouseEnter={loadIndex}>
      <MagnifyingGlassIcon aria-hidden className="h-4 w-4" />
      <span className="flex-1 text-left">Search docs</span>
      <kbd className="docs-kbd">{mac ? '⌘' : 'Ctrl'} K</kbd>
    </button>
  );
}

export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [records, setRecords] = useState<SearchRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    inputRef.current?.focus();
    loadIndex()
      .then(setRecords)
      .catch(() => setFailed(true));
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const hits = useMemo(
    () => (records && query.trim() ? searchRecords(records, query, 12) : []),
    [records, query],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection per query
  useEffect(() => setSelected(0), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open) return null;

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') onClose();
    else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((i) => Math.min(i + 1, hits.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter' && hits[selected]) {
      event.preventDefault();
      go(hits[selected].record.href);
    }
  };

  let status: string | null = null;
  if (failed) status = 'Search is unavailable right now.';
  else if (!records) status = 'Loading…';
  else if (!query.trim())
    status = 'Search pages, sections and code across Agents, Evals and Tracing.';
  else if (!hits.length) status = `No results for “${query}”.`;

  return (
    <div className="docs-search-overlay">
      {/* Clicking outside the dialog closes it; Esc does the same from the keyboard. */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close search"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search docs"
        className="docs-search glass relative"
        onKeyDown={onKeyDown}
      >
        <div className="docs-search-input">
          <MagnifyingGlassIcon aria-hidden className="h-4 w-4 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the docs"
            aria-label="Search the docs"
            aria-controls="docs-search-results"
            aria-activedescendant={hits[selected] ? `docs-hit-${selected}` : undefined}
            role="combobox"
            aria-expanded={hits.length > 0}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="docs-kbd">Esc</kbd>
        </div>
        {status ? (
          <p className="px-4 py-8 text-center text-sm text-text-3">{status}</p>
        ) : (
          <div
            ref={listRef}
            id="docs-search-results"
            role="listbox"
            className="docs-search-results"
          >
            {hits.map(({ record }, index) => (
              // Focus stays in the input (combobox pattern); arrows and Enter drive the options.
              <div
                key={record.id}
                id={`docs-hit-${index}`}
                data-index={index}
                role="option"
                tabIndex={-1}
                aria-selected={index === selected}
                className={`docs-hit ${index === selected ? 'docs-hit-active' : ''}`}
                onMouseMove={() => setSelected(index)}
                onClick={() => go(record.href)}
                onKeyDown={onKeyDown}
              >
                <span className="docs-hit-icon">
                  {record.heading ? (
                    <HashIcon aria-hidden className="h-3.5 w-3.5" />
                  ) : (
                    <FileTextIcon aria-hidden className="h-3.5 w-3.5" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="docs-hit-title">{record.heading ?? record.pageTitle}</span>
                  <span className="docs-hit-path">
                    {record.tab} / {record.pageTitle}
                  </span>
                  {record.text ? (
                    <span className="docs-hit-text">{excerpt(record.text, query)}</span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
