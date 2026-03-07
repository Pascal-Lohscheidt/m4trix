import { Logger } from '../../utility/Logger';

/**
 * Represents the current state of the voice agent in the conversation flow.
 */
export type VoiceAgentState =
  | 'READY'
  | 'RECORDING'
  | 'UPSTREAMING'
  | 'PROCESSING'
  | 'DOWNSTREAMING'
  | 'RESPONDING';

export type PlayAudioStreamParams = {
  response: Response;
  mimeCodec?: string;
  onComplete?: () => void;
};

export type PlayAudioParams = {
  source: Blob | string;
  onComplete?: () => void;
};

export type InitializeChunkStreamParams = {
  onComplete?: () => void;
  mimeCodec?: string;
};

/**
 * Abstract controller for managing audio output operations.
 * Defines the interface for playing back audio responses.
 */
export abstract class OutputAudioController {
  protected logger: Logger;

  constructor(loggerName: string) {
    this.logger = new Logger(loggerName);
  }

  /**
   * Play either a Blob or a URL string.
   */
  public abstract playAudio(params: PlayAudioParams): Promise<void>;

  /**
   * Stream audio from a Response.
   */
  public abstract playAudioStream(params: PlayAudioStreamParams): Promise<void>;

  /**
   * Initialize a streaming audio context for chunk-based playback.
   */
  public abstract initializeChunkStream(
    params: InitializeChunkStreamParams
  ): Promise<{
    addChunkToStream: (chunk: ArrayBuffer | Blob) => Promise<void>;
    endChunkStream: () => void;
  }>;

  /**
   * Stop any ongoing audio playback.
   */
  public abstract stopPlayback(): Promise<void>;

  /**
   * Cleans up all audio playback resources.
   */
  public abstract cleanup(): void;
}
