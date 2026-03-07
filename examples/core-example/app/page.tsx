'use client';

import { useState, useRef, useEffect } from 'react';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
};

type ReasoningEntry = {
  id: string;
  text: string;
  isStreaming: boolean;
};

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [reasoningLog, setReasoningLog] = useState<ReasoningEntry[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const reasoningEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };
  const scrollReasoningToBottom = () => {
    reasoningEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    scrollReasoningToBottom();
  }, [reasoningLog]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;

    setInput('');
    setLoading(true);

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
    };
    const assistantId = crypto.randomUUID();
    const assistantMessage: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);

    const reasoningId = crypto.randomUUID();
    let reasoningStarted = false;

    try {
      const res = await fetch('/api/reasoning', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-correlation-id': 'some-correlation-id',
        },
        body: JSON.stringify({ request: text }),
      });
      if (!res.ok) throw new Error(res.statusText);
      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.name === 'reasoning-for-problem-thought-chunk-created') {
                const chunk = data.payload?.chunk ?? '';
                if (!reasoningStarted) {
                  reasoningStarted = true;
                  setReasoningLog((prev) => [
                    ...prev,
                    { id: reasoningId, text: chunk, isStreaming: true },
                  ]);
                } else {
                  setReasoningLog((prev) =>
                    prev.map((r) => (r.id === reasoningId ? { ...r, text: r.text + chunk } : r)),
                  );
                }
              } else if (data.name === 'reasoning-for-problem-completed') {
                setReasoningLog((prev) =>
                  prev.map((r) => (r.id === reasoningId ? { ...r, isStreaming: false } : r)),
                );
              } else if (data.name === 'message-stream-chunk') {
                const chunk = data.payload?.chunk ?? '';
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, content: m.content + chunk } : m,
                  ),
                );
                if (data.payload?.isFinal) {
                  setLoading(false);
                }
              }
            } catch {
              // skip non-JSON lines
            }
          }
        }
      }
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: `Error: ${e instanceof Error ? e.message : String(e)}`,
                isStreaming: false,
              }
            : m,
        ),
      );
    } finally {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, isStreaming: false } : m)),
      );
    }
  }

  return (
    <div className="flex h-screen bg-zinc-50 font-sans dark:bg-zinc-950">
      {/* Chat panel */}
      <main className="flex flex-1 flex-col">
        <div className="flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-2xl">
            {messages.length === 0 ? (
              <div className="flex h-full items-center justify-center pt-40">
                <p className="text-zinc-500 dark:text-zinc-400">
                  Send a message to start the conversation.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                        msg.role === 'user'
                          ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                          : 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
                      }`}
                    >
                      <pre className="whitespace-pre-wrap font-sans text-sm">
                        {msg.content}
                        {msg.isStreaming && (
                          <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-current" />
                        )}
                      </pre>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="border-t border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mx-auto flex max-w-2xl gap-3">
            <textarea
              className="min-h-[44px] max-h-32 flex-1 resize-none rounded-xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-zinc-900 placeholder-zinc-500 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-400"
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="Type a message..."
              disabled={loading}
            />
            <button
              onClick={sendMessage}
              disabled={loading || !input.trim()}
              className="flex h-11 shrink-0 items-center justify-center rounded-xl bg-zinc-900 px-5 font-medium text-white transition-opacity hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {loading ? (
                <span className="text-sm">Sending...</span>
              ) : (
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 19l9 2-9-18-9 2 9 18z"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
      </main>

      {/* Reasoning sidebar */}
      <aside className="flex w-80 shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <svg
            className="h-4 w-4 text-amber-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
            />
          </svg>
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Reasoning</span>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {reasoningLog.length === 0 ? (
            <p className="pt-8 text-center text-xs text-zinc-400 dark:text-zinc-500">
              Reasoning traces will appear here.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {reasoningLog.map((entry, i) => (
                <div key={entry.id} className="relative">
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                      Thought {i + 1}
                    </span>
                    {entry.isStreaming && (
                      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400 dark:bg-amber-500" />
                    )}
                  </div>
                  <pre className="whitespace-pre-wrap rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 font-sans text-xs leading-relaxed text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
                    {entry.text}
                    {entry.isStreaming && (
                      <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-zinc-400 dark:bg-zinc-500" />
                    )}
                  </pre>
                </div>
              ))}
            </div>
          )}
          <div ref={reasoningEndRef} />
        </div>
      </aside>
    </div>
  );
}
