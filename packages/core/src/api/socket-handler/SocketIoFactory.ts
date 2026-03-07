import { Socket } from 'socket.io';
import { Hooks, SetupSocketHandlersParams } from './socket-factory-types';

export class SocketIoFactory {
  private socket: Socket;
  private prefix: string;
  private hooks: Hooks<Socket>;

  private constructor(socket: Socket, prefix: string, hooks: Hooks<Socket>) {
    this.socket = socket;
    this.prefix = prefix;
    this.hooks = hooks;
  }

  static setupSocketHandlers({
    enableVoiceEvents,
    enableChatEvents,
    enableTranscriptEvents,
    prefix = '',
    socket,
    hooks,
  }: SetupSocketHandlersParams<
    Socket,
    {
      socket: Socket;
    }
  >): void {
    // Adapter will override the hooks

    const factory = new SocketIoFactory(socket, prefix, hooks!);
    if (enableVoiceEvents) {
      factory.setupVoiceEvents();
    }

    if (enableChatEvents) {
      factory.setupChatEvents(socket);
    }

    if (enableTranscriptEvents) {
      factory.setupTranscriptEvents(socket);
    }
  }

  private setupVoiceEvents(): void {
    const {
      onVoiceInputFile,
      onVoiceInputChunk,
      onVoiceInputCommit,
      onVoiceOutputDelta,
      onVoiceOutputCommit,
      onVoiceOutputFile,
      onVoiceOutputTranscriptDelta,
      onVoiceOutputTranscriptFull,
    } = this.hooks;

    const prefix = this.prefixEvent;

    if (onVoiceInputFile) {
      this.socket.on(prefix('voice:input_file'), onVoiceInputFile);
    }

    if (onVoiceInputChunk) {
      this.socket.on(prefix('voice:input_chunk'), onVoiceInputChunk);
    }

    if (onVoiceInputCommit) {
      this.socket.on(prefix('voice:input_commit'), onVoiceInputCommit);
    }

    if (onVoiceOutputDelta) {
      this.socket.on(prefix('voice:output_delta'), onVoiceOutputDelta);
    }

    if (onVoiceOutputCommit) {
      this.socket.on(prefix('voice:output_commit'), onVoiceOutputCommit);
    }

    if (onVoiceOutputFile) {
      this.socket.on(prefix('voice:output_file'), onVoiceOutputFile);
    }

    if (onVoiceOutputTranscriptDelta) {
      this.socket.on(
        prefix('voice:output_transcript_delta'),
        onVoiceOutputTranscriptDelta
      );
    }

    if (onVoiceOutputTranscriptFull) {
      this.socket.on(
        prefix('voice:output_transcript_full'),
        onVoiceOutputTranscriptFull
      );
    }
  }

  private setupChatEvents(_socket: Socket): void {
    // TODO: Implement chat event handler
  }

  private setupTranscriptEvents(_socket: Socket): void {
    // TODO: Implement transcript event handlers
  }

  private prefixEvent(event: string): string {
    return this.prefix ? `${this.prefix}:${event}` : event;
  }
}
