export type VoiceAgentState =
  | 'READY'
  | 'RECORDING'
  | 'UPSTREAMING'
  | 'PROCESSING'
  | 'DOWNSTREAMING'
  | 'RESPONDING';

export type UpstreamMode = 'STREAM_WHILE_TALK' | 'UPLOAD_AFTER_TALK';
export type DownstreamMode = 'STREAM' | 'DOWNLOAD';

export type BaseUseConversationOptions = {
  onStartRecording?: () => void;
  onStopRecording?: () => void;
  onReceive?: (
    blob: Blob,
    playResponseVoice: () => Promise<void> | void,
    stopResponseVoice: () => Promise<void> | void
  ) => void;
  onError?: (stateWhileErrorHappened: VoiceAgentState, error: Error) => void;
  autoPlay?: boolean;
  audioConfig?: Partial<{
    sampleRate: number;
    channelCount: number;
    processingBlockSize: number;
  }>;
};
