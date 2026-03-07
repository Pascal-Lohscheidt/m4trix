# OpenAI Speech-to-Speech Example

This example demonstrates how to integrate the `@m4trix/core` library with OpenAI's speech capabilities to create a speech-to-speech conversation interface.

## Features

- Microphone recording with real-time streaming
- Socket.io-based communication with TypeScript support
- Simple and responsive UI
- Ready for OpenAI integration

## Getting Started

1. Install dependencies:

```bash
pnpm install
```

2. Run the development server:

```bash
pnpm dev
```

This command will start both:
- Next.js frontend (default: http://localhost:3000)
- TypeScript WebSocket server (port 8080) using jiti for runtime compilation

## How It Works

This example uses the `useConversation` hook from `@m4trix/react` to manage speech input and output. The hook handles:

- Audio recording from the microphone
- Audio streaming to the server
- Receiving and playing audio responses

The WebSocket server is implemented in TypeScript and uses Socket.io for real-time communication. Currently, it echoes back received audio. In a future update, this server will be extended to integrate with OpenAI's speech-to-text and text-to-speech APIs.

## Project Structure

- `/src/app`: Next.js frontend application
- `/server`: TypeScript Socket.io server
  - `index.ts`: Main server code
  - `tsconfig.json`: TypeScript configuration for the server
- `/public`: Static assets

## Technical Details

- The server uses `jiti` for on-the-fly TypeScript execution without requiring a separate build step
- Socket.io is used for real-time, bidirectional communication between the client and server
- The `useConversation` hook from `@m4trix/react` handles all audio recording and streaming logic

## Requirements

- Node.js 18+ 
- pnpm
- Modern browser with WebRTC support

## License

MIT 