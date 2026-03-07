'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  VoiceEndpointAdapter,
  BaseVoiceEndpointAdapter,
} from '../../adapter/VoiceEndpointAdapter';
import { Logger } from '../../utility/Logger';
import { WebAudioInputAudioController } from '../../utility/audio/WebAudioInputAudioController';
import { OutputAudioController } from '../../utility/audio/OutputAudioController';
import type {
  BaseUseConversationOptions,
  DownstreamMode,
  VoiceAgentState,
} from './shared-types';
import { AudioElementOutputAudioController } from '../../utility/audio/AudioElementOutputAudioController';
import { InputAudioController } from '../../utility/audio/InputAudioController';

// Types
export type EndpointConversationOptions<
  T extends Record<string, unknown> = Record<string, unknown>,
> = BaseUseConversationOptions & {
  downstreamMode?: DownstreamMode;
  endpointConfig?: {
    baseUrl?: string;
    endpointAdapter?: VoiceEndpointAdapter;
    headers?: Record<string, string>;
  };
  requestData?: T;
  overrideInputAudioController?: InputAudioController;
};

export interface UseEndpointConversationResult {
  startRecording: () => void;
  stopRecording: () => void;
  enableHandsFreeRecording?: () => void;
  voiceAgentState: VoiceAgentState;
  error: Error | null;
  audioContext: AudioContext | null;
}

Logger.enableGlobalLogging();

/**
 * A hook for managing voice conversations in React applications using HTTP endpoints and Web Audio API
 */
export function useConversation<T extends Record<string, unknown>>(
  endpoint: string,
  {
    onStartRecording,
    onStopRecording,
    onReceive,
    autoPlay = true,
    downstreamMode = 'STREAM',
    onError,
    audioConfig = {},
    requestData = {} as T,
    endpointConfig = {},
  }: EndpointConversationOptions<T>
): UseEndpointConversationResult {
  // Refs
  const { current: logger } = useRef<Logger>(
    new Logger('@m4trix/core > useConversation')
  );
  const inputAudioControllerRef = useRef<
    WebAudioInputAudioController | undefined
  >(undefined);
  const outputAudioControllerRef = useRef<OutputAudioController | undefined>(
    undefined
  );

  const endpointAdapterRef = useRef<VoiceEndpointAdapter | undefined>(
    undefined
  );

  // State
  const [voiceAgentState, setVoiceAgentState] =
    useState<VoiceAgentState>('READY');
  const [error, setError] = useState<Error | null>(null);

  // ================================================
  // =============== Callbacks ======================
  // ================================================

  const handleError = useCallback(
    (state: VoiceAgentState, err: Error) => {
      setError(err);
      logger.error(`Error during ${state}:`, err);
      onError?.(state, err);
    },
    [onError]
  );

  const startRecording = useCallback(() => {
    if (inputAudioControllerRef.current) {
      try {
        logger.debug('Starting recording');
        setVoiceAgentState('RECORDING');
        inputAudioControllerRef.current.startRecording({
          onError: (err) => {
            handleError('RECORDING', err);
          },
        });
        onStartRecording?.();
      } catch (err) {
        if (err instanceof Error) {
          handleError('RECORDING', err);
        }
      }
    }
  }, [onStartRecording, handleError]);

  const stopRecording = useCallback(async () => {
    if (inputAudioControllerRef.current) {
      try {
        logger.debug('Stopping recording');
        await inputAudioControllerRef.current.stopRecording({
          onRecordingCompleted: async (allData) => {
            setVoiceAgentState('PROCESSING');
            try {
              // Send the recording to the endpoint
              const response = await endpointAdapterRef.current?.sendVoiceFile({
                blob: allData,
                metadata: requestData,
              });

              if (!response) {
                throw new Error('No response received from endpoint');
              }

              setVoiceAgentState('RESPONDING');

              // Play the response
              if (autoPlay) {
                if (downstreamMode === 'STREAM') {
                  await outputAudioControllerRef.current?.playAudioStream({
                    response,
                    onComplete: () => {
                      setVoiceAgentState('READY');
                    },
                  });
                } else if (downstreamMode === 'DOWNLOAD') {
                  const responseBlob = await response.blob();
                  await outputAudioControllerRef.current?.playAudio({
                    source: responseBlob,
                    onComplete: () => {
                      setVoiceAgentState('READY');
                    },
                  });
                }
              } else {
                setVoiceAgentState('READY');
              }

              // Call onReceive with the recording and response
              onReceive?.(
                allData,
                async () => {
                  // Play response function
                  if (outputAudioControllerRef.current) {
                    if (downstreamMode === 'STREAM') {
                      return outputAudioControllerRef.current.playAudioStream({
                        response,
                        onComplete: () => {
                          setVoiceAgentState('READY');
                        },
                      });
                    } else {
                      const responseBlob = await response.blob();
                      return outputAudioControllerRef.current.playAudio({
                        source: responseBlob,
                        onComplete: () => {
                          setVoiceAgentState('READY');
                        },
                      });
                    }
                  }
                },
                async () => {
                  // Stop response function
                  if (outputAudioControllerRef.current) {
                    return outputAudioControllerRef.current.stopPlayback();
                  }
                }
              );
            } catch (err) {
              if (err instanceof Error) {
                handleError('PROCESSING', err);
              }
              setVoiceAgentState('READY');
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
  }, [
    onStopRecording,
    requestData,
    autoPlay,
    downstreamMode,
    handleError,
    onReceive,
  ]);

  // Setup endpoint adapter and audio controllers
  useEffect(() => {
    if (endpointAdapterRef.current) {
      return;
    }

    try {
      // Set up endpoint adapter
      const endpointAdapter = endpointConfig.endpointAdapter
        ? endpointConfig.endpointAdapter
        : new BaseVoiceEndpointAdapter({
            baseUrl: endpointConfig.baseUrl,
            endpoint: endpoint,
            headers: endpointConfig.headers,
          });

      endpointAdapterRef.current = endpointAdapter;

      // Set up audio controllers
      if (!inputAudioControllerRef.current) {
        inputAudioControllerRef.current = new WebAudioInputAudioController(
          audioConfig
        );
      }

      if (!outputAudioControllerRef.current) {
        outputAudioControllerRef.current =
          new AudioElementOutputAudioController();
      }
    } catch (err) {
      if (err instanceof Error) {
        handleError('READY', err);
      }
    }
  }, [endpoint, endpointConfig, audioConfig, handleError]);

  // On Mount and on unmount, cleanup the audio controller
  useEffect(() => {
    return () => {
      inputAudioControllerRef.current?.cleanup();
      outputAudioControllerRef.current?.cleanup();
    };
  }, []);

  // Return the public API
  return {
    startRecording,
    stopRecording,
    voiceAgentState,
    error,
    audioContext: inputAudioControllerRef.current?.audioContext || null,
  };
}
