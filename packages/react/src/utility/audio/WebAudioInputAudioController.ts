import {
  AudioProcessingConfig,
  InputAudioController,
} from './InputAudioController';
import { AudioContextState } from './InputAudioController';

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

export type StartRecordingCallbacks = {
  onRecordedChunk?: (chunk: Blob) => Promise<void> | void;
  onError?: (error: Error) => Promise<void> | void;
};

export type StopRecordingCallbacks = {
  onRecordingCompleted?: (allData: Blob) => Promise<void> | void;
  onError?: (error: Error) => Promise<void> | void;
};

const DEFAULT_SLICING_INTERVAL = 3_000; // 3 seconds

/**
 * Controller for managing audio input operations.
 * Handles recording from microphone.
 */
export class WebAudioInputAudioController extends InputAudioController {
  // ─── Recording state ─────────────────────────────────────────────────────
  private audioContextState: AudioContextState = {
    context: null,
    source: null,
    analyser: null,
  };
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private recordingStream: MediaStream | null = null;

  constructor(private audioConfig: Partial<AudioProcessingConfig> = {}) {
    super();
  }

  public get audioContext(): AudioContext | null {
    return this.audioContextState.context;
  }

  private async createAudioContext(): Promise<AudioContextState> {
    const context = new AudioContext({
      sampleRate: this.audioConfig.sampleRate || 16_000,
      latencyHint: 'interactive',
    });
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    return { context, source: null, analyser };
  }

  private async cleanupAudioContext(): Promise<void> {
    this.logger.debug('Cleaning up audio context');
    const { source, context } = this.audioContextState;
    if (source) source.disconnect();
    if (context) await context.close();
    this.audioContextState = { context: null, source: null, analyser: null };
  }

  public async startRecording({
    onRecordedChunk,
    onError,
  }: StartRecordingCallbacks = {}): Promise<void> {
    try {
      this.logger.debug('Starting recording');
      this.recordedChunks = [];

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.recordingStream = stream;

      if (!this.audioContextState.context) {
        this.audioContextState = await this.createAudioContext();
      }

      this.mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus',
      });

      this.mediaRecorder.ondataavailable = (e: BlobEvent): void => {
        if (e.data.size > 0) {
          this.recordedChunks.push(e.data);
          onRecordedChunk?.(e.data);
          this.logger.debug('Recorded chunk', e.data.size);
        }
      };

      this.mediaRecorder.start(DEFAULT_SLICING_INTERVAL);
      this.logger.debug('MediaRecorder started');
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error('Failed to start recording');
      this.logger.error(error);
      onError?.(error);
    }
  }

  public async stopRecording({
    onRecordingCompleted,
  }: StopRecordingCallbacks = {}): Promise<void> {
    this.logger.debug('Stopping recording');
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') return;

    await new Promise<void>((resolve) => {
      this.mediaRecorder!.onstop = async (): Promise<void> => {
        if (this.recordedChunks.length) {
          const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
          onRecordingCompleted?.(blob);
          this.logger.debug('Recording completed', blob.size);
        }
        this.recordingStream?.getTracks().forEach((t) => t.stop());
        this.recordingStream = null;
        await this.cleanupAudioContext();
        resolve();
      };
      this.mediaRecorder!.stop();
    });
  }

  /**
   * Cleans up all audio recording resources.
   */
  public cleanup(): void {
    this.cleanupAudioContext();
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    if (this.recordingStream) {
      this.recordingStream.getTracks().forEach((t) => t.stop());
      this.recordingStream = null;
    }
  }
}
