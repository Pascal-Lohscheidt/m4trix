export type Role = 'system' | 'user' | 'assistant' | string;

export interface BaseMessage {
  /** Unique across the conversation */
  id: string;
  role: Role;
  /** ISO string or Date; normalized when you receive it */
  timestamp: string;
}

export interface TextMessage extends BaseMessage {
  kind: 'text';
  /** two modes: plain vs. structured */
  content: string | { format: 'markdown' | 'html'; body: string };
}

export interface VoiceMessage extends BaseMessage {
  kind: 'voice';
  /** raw bytes or reference */
  data: ArrayBuffer | Blob;
  format: 'mp3' | 'wav' | string;
  durationMs: number;
  /** optional transcript if you run speech-to-text */
  transcript?: string;
}

export type Message = TextMessage | VoiceMessage;
