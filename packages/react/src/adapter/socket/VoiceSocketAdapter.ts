import { Logger } from '../../utility/Logger.js';

export interface VoiceSocketConfig {
  scope?: string;
  baseUrl: string;
  protocols?: string | string[];
  headers?: Record<string, string>;
  autoReconnect?: boolean;
}

export interface VoiceSocketMessage {
  type: 'chunk' | 'file';
  data: string; // base64 encoded
  metadata?: Record<string, unknown>;
}

/**
 * Base class for voice socket adapters that handles voice data transmission.
 *
 * Emits:
 * - "connect"
 * - "disconnect"
 * - "error" (with Error)
 * - "chunk-received" (ArrayBuffer)
 * - "received-end-of-response-stream"
 * - "chunk-sent" (ArrayBuffer | Blob)
 * - "file-received" (Blob)
 * - "file-sent" (Blob)
 * - "control-message" (object)
 */
export abstract class VoiceSocketAdapter {
  protected config: VoiceSocketConfig;
  protected _isConnected = false;
  protected logger = new Logger('@m4trix/core > VoiceSocketAdapter');
  protected emitter = new Emitter();

  constructor(config: VoiceSocketConfig) {
    this.config = config;
  }

  on(event: string, listener: (data?: unknown) => void): void {
    this.emitter.on(event, listener);
  }

  off(event: string, listener: (data?: unknown) => void): void {
    this.emitter.off(event, listener);
  }

  once(event: string, listener: (data?: unknown) => void): void {
    this.emitter.once(event, listener);
  }

  protected emit(event: string, data?: unknown): void {
    this.emitter.emit(event, data);
  }

  isConnected(): boolean {
    return this._isConnected;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): void;
  abstract exposeSocket<T>(): T | null;

  abstract sendVoiceChunk(
    chunk: ArrayBuffer | Blob,
    metadata?: Record<string, unknown>,
  ): Promise<void>;

  abstract commitVoiceMessage(): void;

  abstract sendVoiceFile(blob: Blob, metadata?: Record<string, unknown>): void;

  protected abstract onVoiceChunkReceived(chunk: ArrayBuffer): void;
  protected abstract onReceivedEndOfResponseStream(): void;
  protected abstract onVoiceFileReceived(blob: Blob): void;
}
type Listener<T> = (event: T) => void;

export class Emitter {
  private target = new EventTarget();

  on<T>(type: string, listener: Listener<T>): void {
    this.target.addEventListener(type, listener as EventListener);
  }

  off<T>(type: string, listener: Listener<T>): void {
    this.target.removeEventListener(type, listener as EventListener);
  }

  once<T>(type: string, listener: Listener<T>): void {
    const wrapper = (event: Event): void => {
      this.off(type, wrapper);
      listener((event as CustomEvent).detail);
    };
    this.on(type, wrapper);
  }

  emit<T>(type: string, detail?: T): void {
    this.target.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
