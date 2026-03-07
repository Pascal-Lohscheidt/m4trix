export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
};

export type ReasoningEntry = {
  id: string;
  text: string;
  isStreaming: boolean;
};
