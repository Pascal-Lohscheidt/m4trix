import { Logger } from '../../utility/Logger.js';

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

/**
 * Represents the state of the Web Audio API context and nodes.
 */
export type AudioContextState = {
  context: AudioContext | null;
  source: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
};

/**
 * Configuration options for audio processing.
 */
export type AudioProcessingConfig = {
  sampleRate: number;
  channelCount: number;
};

export type StartRecordingCallbacks = {
  onRecordedChunk?: (chunk: Blob) => Promise<void> | void;
  onError?: (error: Error) => Promise<void> | void;
};

export type StopRecordingCallbacks = {
  onRecordingCompleted?: (allData: Blob) => Promise<void> | void;
  onError?: (error: Error) => Promise<void> | void;
};

/**
 * Controller for managing audio input operations.
 * Handles recording from microphone.
 */
export abstract class InputAudioController {
  protected logger = new Logger('@m4trix/core > InputAudioController');

  constructor() {}

  public abstract startRecording({
    onRecordedChunk,
    onError,
  }: StartRecordingCallbacks): Promise<void>;

  public abstract stopRecording({ onRecordingCompleted }: StopRecordingCallbacks): Promise<void>;

  /**
   * Cleans up all audio recording resources.
   */
  public abstract cleanup(): void;
}
