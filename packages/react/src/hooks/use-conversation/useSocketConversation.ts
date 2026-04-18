'use client';
// Voice conversation hook for handling audio recording and playback via socket connection
import { useState, useRef, useEffect, useCallback } from 'react';
import type { VoiceSocketAdapter } from '../../adapter/socket/VoiceSocketAdapter.js';
import { VoiceSocketIOAdapter } from '../../adapter/socket/VoiceSocketIOAdapter.js';
import { Logger } from '../../utility/Logger.js';
import { WebAudioInputAudioController } from '../../utility/audio/WebAudioInputAudioController.js';
import type { OutputAudioController } from '../../utility/audio/OutputAudioController.js';
import { WebAudioOutputAudioController } from '../../utility/audio/WebAudioOutputAudioController.js';
import type {
  BaseUseConversationOptions,
  DownstreamMode,
  UpstreamMode,
  VoiceAgentState,
} from './shared-types.js';

export type SocketConversationOptions<T extends Record<string, unknown> = Record<string, unknown>> =
  BaseUseConversationOptions & {
    scope?: string;
    downstreamMode?: DownstreamMode;
    upstreamMode?: UpstreamMode;
    handsFreeEnginePlugin?: unknown[];
    socketConfig?: {
      baseUrl?: string;
      socketAdapter?: VoiceSocketAdapter;
      headers?: Record<string, string>;
    };
    requestData?: T;
  };

export interface UseSocketConversationResult {
  startRecording: () => void;
  stopRecording: () => void;
  enableHandsFreeRecording?: () => void;
  voiceAgentState: VoiceAgentState;
  error: Error | null;
  audioContext: AudioContext | null;
  socket: unknown | null;
}

Logger.enableGlobalLogging();

/**
 * A hook for managing voice conversations in React applications using WebSockets and Web Audio API
 */
export function useSocketConversation<T extends Record<string, unknown>>({
  scope,
  onStartRecording,
  onStopRecording,
  onReceive,
  upstreamMode = 'STREAM_WHILE_TALK',
  onError,
  audioConfig = {},
  socketConfig = {},
}: SocketConversationOptions<T>): UseSocketConversationResult {
  // Refs
  const { current: logger } = useRef<Logger>(new Logger('SuTr > useSocketConversation'));
  const inputAudioControllerRef = useRef<WebAudioInputAudioController | undefined>(undefined);

  const outputAudioControllerRef = useRef<OutputAudioController | undefined>(undefined);

  const socketAdapterRef = useRef<VoiceSocketAdapter | undefined>(undefined);
  const [socket, setSocket] = useState<unknown | null>(null);

  // State
  const [voiceAgentState, setVoiceAgentState] = useState<VoiceAgentState>('READY');
  const [error, setError] = useState<Error | null>(null);

  // ================================================
  // =============== Inferred Config ================
  // ================================================

  const shouldStreamWhileTalk = upstreamMode === 'STREAM_WHILE_TALK';

  // ================================================
  // =============== Callbacks ======================
  // ================================================

  const handleError = useCallback(
    (state: VoiceAgentState, err: Error) => {
      setError(err);
      logger.error(`Error during ${state}:`, err);
      onError?.(state, err);
    },
    [onError],
  );

  const subscribeToSocketEventsForChunkDownstreaming = useCallback(
    async (socketAdapter: VoiceSocketAdapter) => {
      logger.debug('Setting up audio stream for receiving chunks');

      try {
        const { addChunkToStream, endChunkStream } =
          await outputAudioControllerRef.current!.initializeChunkStream({
            mimeCodec: 'audio/mpeg',
            onComplete: () => {
              logger.debug('Audio stream playback completed');
              setVoiceAgentState('READY');
            },
          });

        // Keep track of received chunks for debugging
        let chunkCount = 0;

        const chunkReceivedEmitter = async (chunk: unknown): Promise<void> => {
          if (chunk instanceof ArrayBuffer) {
            chunkCount++;
            logger.debug(
              `Received voice chunk #${chunkCount} from socket, size: ${chunk.byteLength} bytes`,
            );

            if (!chunk || chunk.byteLength === 0) {
              logger.warn('Received empty chunk, skipping');
              return;
            }

            try {
              await addChunkToStream(chunk);
              logger.debug(`Successfully added chunk #${chunkCount} to audio stream`);
            } catch (err) {
              logger.error(`Failed to add chunk #${chunkCount} to audio stream`, err);
              if (err instanceof Error) {
                handleError('DOWNSTREAMING', err);
              }
            }
          }
        };

        socketAdapter.on('chunk-received', chunkReceivedEmitter);

        const endOfStreamEmitter = (): void => {
          logger.debug(
            `Received end of stream signal after ${chunkCount} chunks, ending chunk stream`,
          );
          endChunkStream();
          setVoiceAgentState('READY');
        };

        socketAdapter.on('received-end-of-response-stream', endOfStreamEmitter);

        // Returning a cleanup callback to remove the event listeners
        return () => {
          logger.debug('Cleaning up socket event listeners');
          socketAdapter.off('chunk-received', chunkReceivedEmitter);
          socketAdapter.off('received-end-of-response-stream', endOfStreamEmitter);
          endChunkStream();
        };
      } catch (err) {
        if (err instanceof Error) {
          handleError('DOWNSTREAMING', err);
        }
        return () => {};
      }
    },
    [handleError],
  );

  const hookupSocketAdapter = useCallback(
    async (socketAdapter: VoiceSocketAdapter) => {
      logger.debug('Connecting to socket...');

      try {
        await socketAdapter.connect();

        socketAdapter.on('connect', () => {
          logger.debug('Socket adapter connected');
          setVoiceAgentState('READY');
        });

        socketAdapter.on('disconnect', () => {
          logger.debug('Socket adapter disconnected');
        });

        socketAdapter.on('error', (err: unknown) => {
          if (err instanceof Error) {
            handleError(voiceAgentState, err);
          } else {
            handleError(voiceAgentState, new Error('Unknown error'));
          }
        });

        setSocket(socketAdapter.exposeSocket<unknown>());
      } catch (err) {
        if (err instanceof Error) {
          handleError('READY', err);
        }
      }
    },
    [handleError, voiceAgentState],
  );

  const startRecording = useCallback(() => {
    if (inputAudioControllerRef.current) {
      try {
        logger.debug('Starting recording');
        setVoiceAgentState('RECORDING');
        inputAudioControllerRef.current.startRecording({
          onRecordedChunk: async (chunk) => {
            if (shouldStreamWhileTalk) {
              try {
                // We do not set UPSTREAMING since we are recording while talking
                await socketAdapterRef.current?.sendVoiceChunk(chunk);
              } catch (err) {
                if (err instanceof Error) {
                  handleError('RECORDING', err);
                }
              }
            }
          },
        });
        onStartRecording?.();
      } catch (err) {
        if (err instanceof Error) {
          handleError('RECORDING', err);
        }
      }
    }
  }, [onStartRecording, shouldStreamWhileTalk, handleError]);

  const stopRecording = useCallback(async () => {
    if (inputAudioControllerRef.current) {
      try {
        logger.debug('Stopping recording');
        await inputAudioControllerRef.current.stopRecording({
          onRecordingCompleted: async (allData) => {
            setVoiceAgentState('PROCESSING');
            try {
              if (shouldStreamWhileTalk) {
                logger.debug('Committing voice message');
                await socketAdapterRef.current?.commitVoiceMessage();
              } else {
                await socketAdapterRef.current?.sendVoiceFile(allData);
              }

              setVoiceAgentState('DOWNSTREAMING');
              await subscribeToSocketEventsForChunkDownstreaming(socketAdapterRef.current!);

              // Handle receiving the audio response
              onReceive?.(
                allData,
                async () => {
                  // Play response function
                  if (outputAudioControllerRef.current) {
                    // Use stopPlayback because it should also have logic to resume or start
                    return outputAudioControllerRef.current.stopPlayback();
                  }
                },
                async () => {
                  // Stop response function
                  if (outputAudioControllerRef.current) {
                    return outputAudioControllerRef.current.stopPlayback();
                  }
                },
              );

              // Event listeners are cleaned up automatically
            } catch (err) {
              if (err instanceof Error) {
                handleError('PROCESSING', err);
              }
            }
          },
        });
        onStopRecording?.();
      } catch (err) {
        if (err instanceof Error) {
          handleError('RECORDING', err);
        }
      }
    }
  }, [onStopRecording, handleError, subscribeToSocketEventsForChunkDownstreaming, onReceive]);

  // Setup Socket Adapter and AudioControllers
  useEffect(() => {
    if (socketAdapterRef.current) {
      return;
    }

    try {
      // Set up socket adapter
      const socketAdapter = socketConfig.socketAdapter
        ? socketConfig.socketAdapter
        : new VoiceSocketIOAdapter({
            scope,
            baseUrl: socketConfig.baseUrl || '',
            headers: socketConfig.headers,
          });

      socketAdapterRef.current = socketAdapter;

      if (!socketAdapter.isConnected()) {
        hookupSocketAdapter(socketAdapter);
      }

      // Set up audio controllers
      if (!inputAudioControllerRef.current) {
        inputAudioControllerRef.current = new WebAudioInputAudioController(audioConfig);
      }

      if (!outputAudioControllerRef.current) {
        outputAudioControllerRef.current = new WebAudioOutputAudioController();
      }
    } catch (err) {
      if (err instanceof Error) {
        handleError('READY', err);
      }
    }
  }, [scope, socketConfig, hookupSocketAdapter, audioConfig, handleError]);

  // On Mount and on unmount, cleanup the audio controller
  useEffect(() => {
    return () => {
      inputAudioControllerRef.current?.cleanup();
      outputAudioControllerRef.current?.cleanup();
      if (socketAdapterRef.current) {
        socketAdapterRef.current.disconnect();
        socketAdapterRef.current = undefined;
      }
    };
  }, []);

  // Return the public API
  return {
    startRecording,
    stopRecording,
    voiceAgentState,
    error,
    audioContext: inputAudioControllerRef.current?.audioContext || null,
    socket,
  };
}
