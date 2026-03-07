'use client';

import { AgentChatUi } from '@/components/chat/agent-chat-ui';
import { ExampleShell } from '@/components/examples/example-shell';
import { useSseAgentChat } from '@/app/_hooks/use-sse-agent-chat';

export default function SseExamplePage() {
  const {
    messages,
    reasoningLog,
    input,
    loading,
    messageEndRef,
    reasoningEndRef,
    setInput,
    sendMessage,
  } = useSseAgentChat();

  return (
    <ExampleShell
      currentPath="/sse"
      title="Core Example: SSE"
      description="Reusable chat components plugged into a basic SSE endpoint."
    >
      <AgentChatUi
        messages={messages}
        reasoningLog={reasoningLog}
        input={input}
        loading={loading}
        messageEndRef={messageEndRef}
        reasoningEndRef={reasoningEndRef}
        onInputChange={setInput}
        onSend={sendMessage}
      />
    </ExampleShell>
  );
}
