export type HookContext<T> = {
  socket: T;
  hooks: Hooks<T>;
};

export type Hooks<SocketType> = {
  onConversationCreated?: (
    conversationId: string,
    context: HookContext<SocketType>
  ) => void;
  onVoiceInputFile?: (
    file: Blob | Uint8Array,
    context: HookContext<SocketType>
  ) => void;
  onVoiceInputChunk?: (
    chunk: Uint8Array,
    context: HookContext<SocketType>
  ) => void;
  onVoiceInputCommit?: (context: HookContext<SocketType>) => void;
  onVoiceOutputDelta?: (
    chunk: Uint8Array,
    context: HookContext<SocketType>
  ) => void;
  onVoiceOutputCommit?: (context: HookContext<SocketType>) => void;
  onVoiceOutputFile?: (
    file: Blob | Uint8Array,
    context: HookContext<SocketType>
  ) => void;
  onVoiceOutputTranscriptDelta?: (
    transcriptChunk: string,
    context: HookContext<SocketType>
  ) => void;
  onVoiceOutputTranscriptFull?: (
    transcript: string,
    context: HookContext<SocketType>
  ) => void;
};

type BaseSetupSocketHandlersParams<SocketType> = {
  enableVoiceEvents: boolean;
  enableChatEvents: boolean;
  enableTranscriptEvents: boolean;
  prefix?: string;
  hooks?: Hooks<SocketType>;
};

/**
 * Extra keys supplied by the caller are kept,
 * but if they collide with a base key the base type wins.
 */
export type SetupSocketHandlersParams<
  SocketType,
  Extra = Record<string, never>,
> = Omit<Extra, keyof BaseSetupSocketHandlersParams<SocketType>> &
  BaseSetupSocketHandlersParams<SocketType>;

/**
 * A Socket Factory Adapter is a function that pre defines hooks and returns hooks living in a stateful context.
 * These for example can give you a custumisable quick start for your socket setup.
 *
 * e.g. live transcription in a voice chat.
 */
export type SocketFactoryAdapter<
  SocketType,
  T extends Partial<Hooks<SocketType>>,
> = (hooks: T) => void;
