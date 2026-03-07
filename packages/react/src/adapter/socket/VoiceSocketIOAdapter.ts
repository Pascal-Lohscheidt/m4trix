import { VoiceSocketAdapter, VoiceSocketConfig } from './VoiceSocketAdapter';
import { Socket, io } from 'socket.io-client';

// Define an interface that extends the VoiceSocketAdapter with Socket.IO specific properties
export class VoiceSocketIOAdapter extends VoiceSocketAdapter {
  protected socket: Socket | null = null;

  constructor(config: VoiceSocketConfig) {
    super(config);
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        this.socket = io(this.config.baseUrl, {
          extraHeaders: this.config.headers,
          autoConnect: true,
        });
      }

      this.socket.on('connect', () => {
        this._isConnected = true;
        this.logger.debug('Connected to socket');
        this.emit('connect');
        resolve();
      });

      this.socket.on('disconnect', () => {
        this._isConnected = false;
        this.emit('disconnect');
        this.logger.debug('Disconnected from socket');
        if (this.config.autoReconnect) this.connect(); // reconnect if configured
      });

      this.socket.on('connect_error', (error) => {
        this.logger.error('Error connecting to socket', error);
        this.emit('error', error);
        reject(error);
      });

      this.socket.on('voice:chunk_received', (chunk: ArrayBuffer) => {
        this.logger.debug('Received voice chunk', chunk.byteLength);
        this.onVoiceChunkReceived(chunk);
      });

      this.socket.on('voice:received_end_of_response_stream', () => {
        this.logger.debug('Received end of response stream');
        this.onReceivedEndOfResponseStream();
      });

      this.socket.on('voice:file_received', (blob: Blob) => {
        this.logger.debug('Received voice file');
        this.onVoiceFileReceived(blob);
      });

      // TODO: remove?
      this.socket.on('control-message', (message: Record<string, unknown>) => {
        this.logger.debug('Received control message', message);
        this.emit('control-message', message);
      });
    });
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
    this._isConnected = false;
  }

  exposeSocket<T>(): T | null {
    return this.socket as T | null;
  }

  async sendVoiceChunk(
    chunk: ArrayBuffer | Blob,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(
      'Sending voice chunk %i',
      chunk instanceof Blob ? chunk.size : chunk.byteLength
    );
    if (!this.socket || !this.isConnected)
      throw new Error('Socket not connected');

    let chunkToSend: ArrayBuffer;
    if (chunk instanceof Blob) {
      chunkToSend = await chunk.arrayBuffer();
    } else {
      chunkToSend = chunk;
    }

    this.logger.debug('[Socket] Sending voice chunk', chunkToSend.byteLength);

    this.socket.emit('voice:send_chunk', chunkToSend, metadata);
    this.emit('chunk_sent', chunk);
  }

  sendVoiceFile(blob: Blob, metadata?: Record<string, unknown>): void {
    this.logger.debug('Sending voice file', blob, metadata);
    if (!this.socket || !this.isConnected)
      throw new Error('Socket not connected');

    this.socket.emit('voice:send_file', blob, metadata);
    this.emit('file-sent', blob);
  }

  commitVoiceMessage(): void {
    if (!this.socket || !this.isConnected)
      throw new Error('Socket not connected');

    this.socket.emit('voice:commit');
  }

  protected onVoiceChunkReceived(chunk: ArrayBuffer): void {
    this.emit('chunk-received', chunk);
  }

  protected onVoiceFileReceived(blob: Blob): void {
    this.emit('file-received', blob);
  }

  protected onReceivedEndOfResponseStream(): void {
    this.emit('received-end-of-response-stream');
  }
}
