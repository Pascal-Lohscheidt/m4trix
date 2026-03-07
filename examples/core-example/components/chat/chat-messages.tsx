import type { RefObject } from 'react';
import type { ChatMessage } from './types';

type ChatMessagesProps = {
  messages: ChatMessage[];
  endRef: RefObject<HTMLDivElement | null>;
};

export function ChatMessages({ messages, endRef }: ChatMessagesProps) {
  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      <div className="mx-auto max-w-2xl">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center pt-40">
            <p className="text-zinc-500 dark:text-zinc-400">Send a message to start the conversation.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
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
        <div ref={endRef} />
      </div>
    </div>
  );
}
