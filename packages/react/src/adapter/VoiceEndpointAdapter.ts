import { Logger } from '../utility/Logger';

export interface VoiceEndpointConfig {
  baseUrl?: string;
  endpoint: string;
  headers?: Record<string, string>;
}

export interface SendVoiceFileParams {
  blob: Blob;
  metadata?: Record<string, unknown>;
  onChunk?: (chunk: Uint8Array) => void;
  onComplete?: (response: Blob) => void;
}

/**
 * Adapter for sending voice files to an API endpoint
 */
export abstract class VoiceEndpointAdapter {
  protected config: VoiceEndpointConfig;
  protected logger = new Logger('SuTr > EndpointAdapter');

  constructor(config: VoiceEndpointConfig) {
    this.config = config;
  }

  /**
   * Send a voice file to the API endpoint and return a Pump stream of audio chunks
   */
  abstract sendVoiceFile(params: SendVoiceFileParams): Promise<Response>;
}

/**
 * Adapter for sending voice files to an API endpoint
 */
export class BaseVoiceEndpointAdapter extends VoiceEndpointAdapter {
  constructor(config: VoiceEndpointConfig) {
    super(config);
  }

  /**
   * Send a voice file to the API endpoint and return a Pump stream of audio chunks
   */
  async sendVoiceFile({
    blob,
    metadata,
  }: SendVoiceFileParams): Promise<Response> {
    const formData = new FormData();
    formData.append('audio', blob);
    if (metadata) {
      formData.append('metadata', JSON.stringify(metadata));
    }
    this.logger.debug('Sending voice file to', this.config.endpoint, formData);
    const response = await fetch(
      `${this.config.baseUrl || ''}${this.config.endpoint}`,
      {
        method: 'POST',
        headers: this.config.headers,
        body: formData,
      }
    );
    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${await response.text()}`);
    }
    if (!response.body) {
      throw new Error('No response body');
    }
    // Return a Pump stream of Uint8Array chunks
    return response;
  }
}
