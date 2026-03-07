'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ReasoningEntry } from '@/components/chat/types';

type AgentNetworkEvent = {
  name?: string;
  payload?: {
    chunk?: string;
    isFinal?: boolean;
  };
};

export function useSseAgentChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [reasoningLog, setReasoningLog] = useState<ReasoningEntry[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const reasoningEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    reasoningEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [reasoningLog]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;

    setInput('');
    setLoading(true);

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
    };
    const assistantId = crypto.randomUUID();
    const reasoningId = crypto.randomUUID();
    let reasoningStarted = false;

    setMessages((prev) => [
      ...prev,
      userMessage,
      { id: assistantId, role: 'assistant', content: '', isStreaming: true },
    ]);

    try {
      const response = await fetch('/sse/api', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-correlation-id': crypto.randomUUID(),
        },
        body: JSON.stringify({ request: text }),
      });

      if (!response.ok) throw new Error(response.statusText);
      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          let event: AgentNetworkEvent;
          try {
            event = JSON.parse(line.slice(6)) as AgentNetworkEvent;
          } catch {
            continue;
          }

          if (event.name === 'reasoning-for-problem-thought-chunk-created') {
            const chunk = event.payload?.chunk ?? '';
            if (!reasoningStarted) {
              reasoningStarted = true;
              setReasoningLog((prev) => [...prev, { id: reasoningId, text: chunk, isStreaming: true }]);
            } else {
              setReasoningLog((prev) =>
                prev.map((entry) =>
                  entry.id === reasoningId ? { ...entry, text: entry.text + chunk } : entry,
                ),
              );
            }
            continue;
          }

          if (event.name === 'reasoning-for-problem-completed') {
            setReasoningLog((prev) =>
              prev.map((entry) => (entry.id === reasoningId ? { ...entry, isStreaming: false } : entry)),
            );
            continue;
          }

          if (event.name === 'message-stream-chunk') {
            const chunk = event.payload?.chunk ?? '';
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId ? { ...message, content: message.content + chunk } : message,
              ),
            );

            if (event.payload?.isFinal) {
              setLoading(false);
            }
          }
        }
      }
    } catch (error) {
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: `Error: ${error instanceof Error ? error.message : String(error)}`,
                isStreaming: false,
              }
            : message,
        ),
      );
    } finally {
      setLoading(false);
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId ? { ...message, isStreaming: false } : message,
        ),
      );
      setReasoningLog((prev) =>
        prev.map((entry) => (entry.id === reasoningId ? { ...entry, isStreaming: false } : entry)),
      );
    }
  }

  return {
    messages,
    reasoningLog,
    input,
    loading,
    messageEndRef,
    reasoningEndRef,
    setInput,
    sendMessage,
  };
}
