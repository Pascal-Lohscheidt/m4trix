'use client';

import type { RefObject } from 'react';
import { ChatComposer } from './chat-composer';
import { ChatMessages } from './chat-messages';
import { ReasoningSidebar } from './reasoning-sidebar';
import type { ChatMessage, ReasoningEntry } from './types';

type AgentChatUiProps = {
  messages: ChatMessage[];
  reasoningLog: ReasoningEntry[];
  input: string;
  loading: boolean;
  messageEndRef: RefObject<HTMLDivElement | null>;
  reasoningEndRef: RefObject<HTMLDivElement | null>;
  onInputChange: (value: string) => void;
  onSend: () => void;
};

export function AgentChatUi({
  messages,
  reasoningLog,
  input,
  loading,
  messageEndRef,
  reasoningEndRef,
  onInputChange,
  onSend,
}: AgentChatUiProps) {
  return (
    <div className="flex h-[calc(100vh-72px)] min-h-[600px] bg-zinc-50 dark:bg-zinc-950">
      <main className="flex flex-1 flex-col">
        <ChatMessages messages={messages} endRef={messageEndRef} />
        <ChatComposer input={input} loading={loading} onInputChange={onInputChange} onSend={onSend} />
      </main>
      <ReasoningSidebar reasoningLog={reasoningLog} endRef={reasoningEndRef} />
    </div>
  );
}
