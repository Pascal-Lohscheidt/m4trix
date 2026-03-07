import { VoiceSocketAdapter, VoiceSocketConfig } from './VoiceSocketAdapter';

export class VoiceWebsocketAdapter extends VoiceSocketAdapter {
  protected socket: WebSocket | null = null;

  constructor(config: VoiceSocketConfig) {
    super(config);
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        this.socket = new WebSocket(this.config.baseUrl, this.config.protocols);
      }

      this.socket.binaryType = 'arraybuffer';

      this.socket.onopen = (): void => {
        this._isConnected = true;
        this.emit('connect');
        resolve();
      };

      this.socket.onclose = (): void => {
        this._isConnected = false;
        this.emit('disconnect');
        if (this.config.autoReconnect) this.connect(); // naive reconnect
      };

      this.socket.onerror = (e: Event): void => {
        const errorEvent = e as ErrorEvent;
        this.emit('error', errorEvent);
        reject(errorEvent);
      };

      this.socket.onmessage = (event: MessageEvent): void => {
        try {
          const { data } = event;

          if (typeof data === 'string') {
            // Optional: handle control messages
            try {
              const controlMsg = JSON.parse(data);
              this.emit('control-message', controlMsg);
            } catch (err) {
              this.emit('error', new Error('Invalid control JSON'));
            }
          } else if (data instanceof ArrayBuffer) {
            // Binary voice chunk
            this.onVoiceChunkReceived(data);
          }
        } catch (err) {
          this.emit('error', err);
        }
      };
    });
  }

  exposeSocket<T>(): T | null {
    return this.socket as T | null;
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = null;
    this._isConnected = false;
  }

  async sendVoiceChunk(
    chunk: ArrayBuffer | Blob,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    let chunkToSend: ArrayBuffer;
    if (chunk instanceof Blob) {
      chunkToSend = await chunk.arrayBuffer();
    } else {
      chunkToSend = chunk;
    }

    if (!this.socket || !this.isConnected)
      throw new Error('Socket not connected');

    // If metadata is provided, we could send it as a separate text frame
    if (metadata) {
      this.socket.send(JSON.stringify({ type: 'metadata', data: metadata }));
    }

    this.socket.send(chunkToSend);
    this.emit('chunk-sent', chunk);
  }

  sendVoiceFile(blob: Blob, metadata?: Record<string, unknown>): void {
    if (!this.socket || !this.isConnected)
      throw new Error('Socket not connected');

    // If metadata is provided, we could send it as a separate text frame
    if (metadata) {
      this.socket.send(JSON.stringify({ type: 'metadata', data: metadata }));
    }

    this.socket.send(blob);
    this.emit('file-sent', blob);
  }

  commitVoiceMessage(): void {
    // TODO: Implement
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
