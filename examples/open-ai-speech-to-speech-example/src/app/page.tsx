'use client';

import { useState, useRef } from 'react';
import { useConversation } from '@m4trix/react';
import { MicrophoneIcon, StopIcon } from '@heroicons/react/24/solid';

export default function SpeechToSpeechPage() {
  const [transcript, setTranscript] = useState<string>('');
  const [response, setResponse] = useState<string>('');
  const socketUrl = useRef('http://localhost:8080');

  const { startRecording, stopRecording, voiceAgentState } = useConversation(
    'speech',
    {
      backendMode: 'socket',
      upstreamMode: 'STREAM_WHILE_TALK',
      downstreamMode: 'STREAM',
      autoPlay: true,
      onStartRecording: () => {
        setTranscript('');
        setResponse('');
      },
      onStopRecording: () => {
        console.log('Recording stopped');
      },
      onReceive: (
        blob: Blob,
        _playResponse: () => void,
        _stopResponse: () => void
      ) => {
        // This would handle the received audio response
        console.log('Received response blob:', blob);
      },
      backendConfig: {
        baseUrl: socketUrl.current,
      },
    }
  );

  const isRecording = voiceAgentState === 'RECORDING';

  const handleToggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 bg-gradient-to-b from-gray-50 to-gray-100">
      <div className="w-full max-w-lg mx-auto space-y-8">
        <h1 className="text-4xl font-bold text-center text-gray-800 tracking-tight">
          OpenAI Speech-to-Speech
        </h1>

        <div className="bg-white rounded-xl shadow-lg p-8 border border-gray-100">
          <div className="flex flex-col items-center space-y-6">
            <div className="flex items-center justify-center w-full">
              <span
                className={`px-4 py-2 rounded-full text-sm font-medium ${
                  isRecording
                    ? 'bg-red-100 text-red-800'
                    : voiceAgentState === 'IDLE'
                      ? 'bg-blue-100 text-blue-800'
                      : 'bg-yellow-100 text-yellow-800'
                }`}
              >
                {voiceAgentState}
              </span>
            </div>

            <button
              onClick={handleToggleRecording}
              className={`w-20 h-20 rounded-full flex items-center justify-center shadow-md transform transition-all duration-300 hover:scale-105 ${
                isRecording
                  ? 'bg-red-500 hover:bg-red-600 ring-4 ring-red-200'
                  : 'bg-blue-500 hover:bg-blue-600 ring-4 ring-blue-200'
              } text-white`}
              aria-label={isRecording ? 'Stop recording' : 'Start recording'}
            >
              {isRecording ? (
                <StopIcon className="w-10 h-10" />
              ) : (
                <MicrophoneIcon className="w-10 h-10" />
              )}
            </button>

            <div className="w-full space-y-6 mt-6">
              {transcript && (
                <div className="rounded-lg overflow-hidden border border-gray-200">
                  <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
                    <h3 className="text-sm font-semibold text-gray-700">
                      You said:
                    </h3>
                  </div>
                  <div className="p-4 bg-white">
                    <p className="text-gray-800 font-medium">{transcript}</p>
                  </div>
                </div>
              )}

              {response && (
                <div className="rounded-lg overflow-hidden border border-gray-200">
                  <div className="bg-blue-50 px-4 py-2 border-b border-gray-200">
                    <h3 className="text-sm font-semibold text-blue-700">
                      Response:
                    </h3>
                  </div>
                  <div className="p-4 bg-white">
                    <p className="text-gray-800 font-medium">{response}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <p className="text-center text-gray-500 text-sm">
          Speak clearly into your microphone and wait for a response
        </p>
      </div>
    </main>
  );
}
