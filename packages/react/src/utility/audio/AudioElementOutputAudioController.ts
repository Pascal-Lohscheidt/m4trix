import {
  OutputAudioController,
  PlayAudioParams,
  PlayAudioStreamParams,
  InitializeChunkStreamParams,
} from './OutputAudioController';

/**
 * Web API implementation of the OutputAudioController.
 * Uses Web Audio API and MediaSource Extensions for audio playback.
 */

export class AudioElementOutputAudioController extends OutputAudioController {
  // ─── Playback state ──────────────────────────────────────────────────────
  private currentHtmlAudio: HTMLAudioElement | null = null;
  private currentAudioUrl: string | null = null;

  constructor() {
    super('@m4trix/core > WebApiOutputAudioController');
  }

  // ─── One-shot playback ────────────────────────────────────────────────────
  /**
   * Play either a Blob or a URL string.
   * Uses <audio> under the hood for maximum browser compatibility.
   */
  public async playAudio({
    source,
    onComplete,
  }: PlayAudioParams): Promise<void> {
    // Tear down any previous playback
    if (this.currentHtmlAudio) {
      this.currentHtmlAudio.pause();
      this.currentHtmlAudio.src = '';
      if (this.currentAudioUrl && source instanceof Blob) {
        URL.revokeObjectURL(this.currentAudioUrl);
      }
    }

    const audio = new Audio();
    this.currentHtmlAudio = audio;

    let url: string;
    if (source instanceof Blob) {
      url = URL.createObjectURL(source);
      this.currentAudioUrl = url;
      audio.onended = (): void => {
        URL.revokeObjectURL(url);
        onComplete?.();
      };
    } else {
      url = source;
    }

    audio.src = url;
    try {
      await audio.play();
    } catch (err) {
      this.logger.error('Playback failed, user gesture may be required', err);
      // UI can retry via user interaction
    }
  }

  // ─── Streaming playback ──────────────────────────────────────────────────
  /**
   * Stream audio from a Response via MediaSource Extensions.
   * @param params.response The fetch Response whose body is an audio stream
   * @param params.mimeCodec MIME type+codec string, e.g. 'audio/mpeg'
   * @param params.onComplete Optional callback once the stream ends
   */
  public async playAudioStream({
    response,
    mimeCodec = 'audio/mpeg',
    onComplete,
  }: PlayAudioStreamParams): Promise<void> {
    // 1) Validation
    if (!response.ok || !response.body) {
      throw new Error(`Invalid response (${response.status})`);
    }
    if (
      typeof MediaSource === 'undefined' ||
      !MediaSource.isTypeSupported(mimeCodec)
    ) {
      throw new Error(`Unsupported MIME type or codec: ${mimeCodec}`);
    }

    // 2) Stop any prior playback
    await this.stopPlayback();

    // 3) Create MediaSource + <audio>
    const mediaSource = new MediaSource();
    const url = URL.createObjectURL(mediaSource);
    this.currentAudioUrl = url;

    const audio = new Audio(url);
    this.currentHtmlAudio = audio;
    audio.autoplay = true;
    audio.onended = (): void => {
      URL.revokeObjectURL(url);
      this.currentAudioUrl = null;
      onComplete?.();
    };

    // 4) Pump incoming bytes into the SourceBuffer
    mediaSource.addEventListener(
      'sourceopen',
      () => {
        const sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
        const reader = response.body!.getReader();

        const pump = async (): Promise<void> => {
          const { done, value } = await reader.read();
          if (done) {
            mediaSource.endOfStream();
            return;
          }
          if (value) {
            sourceBuffer.appendBuffer(value);
          }
          if (sourceBuffer.updating) {
            sourceBuffer.addEventListener('updateend', pump, { once: true });
          } else {
            pump();
          }
        };

        pump();
      },
      { once: true }
    );

    // 5) Kick off playback
    try {
      await audio.play();
    } catch (err) {
      this.logger.error(
        'Streaming playback failed, user gesture may be required',
        err
      );
    }
  }

  // ─── Chunk-based streaming playback ─────────────────────────────────────
  /**
   * Initialize a streaming audio context for chunk-based playback.
   * This creates the necessary MediaSource and SourceBuffer for subsequent chunk additions.
   * Returns functions to add chunks and end the stream, encapsulated in a closure.
   *
   * @param mimeCodec MIME type+codec string, e.g. 'audio/mpeg'
   * @param onComplete Optional callback once the stream ends
   * @returns Object containing functions to add chunks and end the stream
   */
  public async initializeChunkStream({
    onComplete,
    mimeCodec = 'audio/mpeg',
  }: InitializeChunkStreamParams): Promise<{
    addChunkToStream: (chunk: ArrayBuffer | Blob) => Promise<void>;
    endChunkStream: () => void;
  }> {
    this.logger.debug(`Initializing chunk stream with codec: ${mimeCodec}`);

    // 1) Check for MediaSource support and codec support
    if (typeof MediaSource === 'undefined') {
      throw new Error('MediaSource API is not supported in this browser');
    }

    // Check for codec support before proceeding
    if (!MediaSource.isTypeSupported(mimeCodec)) {
      this.logger.warn(
        `Codec ${mimeCodec} not supported, falling back to standard audio/mpeg`
      );
      mimeCodec = 'audio/mpeg';

      // Double check for mpeg support
      if (!MediaSource.isTypeSupported(mimeCodec)) {
        throw new Error(
          'Neither the specified codec nor the fallback codec are supported'
        );
      }
    }

    // 2) Stop any prior playback
    await this.stopPlayback();

    // 3) Create MediaSource + <audio>
    const mediaSource = new MediaSource();
    let sourceBuffer: SourceBuffer | null = null;

    const url = URL.createObjectURL(mediaSource);
    this.currentAudioUrl = url;

    const audio = new Audio(url);
    this.currentHtmlAudio = audio;

    // Prepare audio element
    audio.autoplay = false;

    // Enable audio element for debugging
    audio.controls = true; // Make controls visible for debugging
    audio.style.display = 'none'; // Hide element but keep it active
    document.body.appendChild(audio); // Attach to DOM for better browser support

    // Track playback state
    let playbackStarted = false;
    let hasReceivedFirstChunk = false;
    let receivedChunksCount = 0;

    // Create a queue to handle chunks while buffer is updating
    const pendingChunks: ArrayBuffer[] = [];
    let isProcessingQueue = false;

    // 4) Wait for MediaSource to be ready
    this.logger.debug('Waiting for MediaSource to open...');
    await new Promise<void>((resolve, reject) => {
      // Set timeout for MediaSource open
      const timeout = setTimeout(() => {
        reject(new Error('MediaSource failed to open (timeout)'));
      }, 5000);

      mediaSource.addEventListener(
        'sourceopen',
        () => {
          clearTimeout(timeout);
          this.logger.debug('MediaSource open event received');

          try {
            sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
            // Increase buffer size for smoother playback
            if (
              mediaSource.duration === Infinity ||
              isNaN(mediaSource.duration)
            ) {
              mediaSource.duration = 1000; // Set a large duration to allow for more buffering
            }
            this.logger.debug('SourceBuffer created successfully');
            resolve();
          } catch (err) {
            reject(new Error(`Failed to create SourceBuffer: ${err}`));
          }
        },
        { once: true }
      );
    });

    const logger = this.logger;

    // Process the queue of pending chunks
    const processQueue = async (): Promise<void> => {
      if (!sourceBuffer || pendingChunks.length === 0 || isProcessingQueue) {
        return;
      }

      isProcessingQueue = true;

      try {
        while (pendingChunks.length > 0) {
          if (sourceBuffer.updating) {
            // Wait for the current update to complete before processing more chunks
            await new Promise<void>((resolve) => {
              sourceBuffer!.addEventListener('updateend', () => resolve(), {
                once: true,
              });
            });
          }

          // Get the next chunk from the queue
          const nextChunk = pendingChunks.shift();
          if (!nextChunk) continue;

          try {
            sourceBuffer.appendBuffer(nextChunk);
            logger.debug(
              `Processed queued chunk of size ${nextChunk.byteLength}`
            );

            // Start playback on first successful append if not started yet
            if (!playbackStarted && hasReceivedFirstChunk) {
              await tryStartPlayback();
            }

            // Wait for this append to complete
            await new Promise<void>((resolve) => {
              sourceBuffer!.addEventListener('updateend', () => resolve(), {
                once: true,
              });
            });
          } catch (err) {
            logger.error('Error appending queued chunk to source buffer', err);
            // Continue processing the queue despite errors
          }
        }
      } finally {
        isProcessingQueue = false;
      }
    };

    // Try to start audio playback with proper error handling
    const tryStartPlayback = async (): Promise<void> => {
      if (playbackStarted) return;

      playbackStarted = true;
      logger.debug('Attempting to start audio playback...');

      // Ensure we have enough data before playing
      // (wait for at least 3 chunks or enough buffered time)
      if (
        receivedChunksCount < 3 &&
        audio.buffered.length > 0 &&
        audio.buffered.end(0) < 0.5
      ) {
        logger.debug('Not enough data buffered yet, delaying playback');
        return;
      }

      try {
        // Ensure audio element is ready
        if (audio.readyState === 0) {
          logger.debug(
            'Audio element not ready yet, waiting for canplay event'
          );
          await new Promise<void>((resolve) => {
            audio.addEventListener('canplay', () => resolve(), { once: true });
          });
        }

        await audio.play();
        logger.debug('Successfully started audio playback');
      } catch (err) {
        logger.error('Failed to start playback', err);

        // Try again with user interaction simulation
        document.addEventListener(
          'click',
          async () => {
            try {
              await audio.play();
              logger.debug('Started playback after user interaction');
            } catch (innerErr) {
              logger.error(
                'Still failed to play after user interaction',
                innerErr
              );
            }
          },
          { once: true }
        );
      }
    };

    // Define function for adding chunks
    const addChunkToStream = async (
      chunk: ArrayBuffer | Blob
    ): Promise<void> => {
      if (!sourceBuffer) {
        throw new Error(
          'Streaming context was closed or not properly initialized.'
        );
      }

      // Convert Blob to ArrayBuffer if needed
      let arrayBufferChunk: ArrayBuffer;
      if (chunk instanceof Blob) {
        logger.debug('Converting Blob to ArrayBuffer');
        arrayBufferChunk = await chunk.arrayBuffer();
      } else {
        arrayBufferChunk = chunk;
      }

      // Skip empty chunks
      if (!arrayBufferChunk || arrayBufferChunk.byteLength === 0) {
        logger.warn('Received empty chunk, skipping');
        return;
      }

      // Log first chunk received
      if (!hasReceivedFirstChunk) {
        hasReceivedFirstChunk = true;
        logger.debug(
          `First chunk received, size: ${arrayBufferChunk.byteLength} bytes`
        );
      }

      receivedChunksCount++;

      // Add the chunk to the queue
      pendingChunks.push(arrayBufferChunk);
      logger.debug(
        `Added chunk #${receivedChunksCount} to queue (size: ${arrayBufferChunk.byteLength} bytes)`
      );

      // Start processing the queue if not already processing
      await processQueue();

      // Try to start playback if we have enough data (and not started yet)
      if (
        !playbackStarted &&
        hasReceivedFirstChunk &&
        receivedChunksCount >= 3
      ) {
        await tryStartPlayback();
      }
    };

    // Define function for ending the stream
    const endChunkStream = (): void => {
      if (mediaSource && mediaSource.readyState === 'open') {
        try {
          // Wait for any pending chunks to be processed
          if (
            pendingChunks.length > 0 ||
            (sourceBuffer && sourceBuffer.updating)
          ) {
            logger.debug('Waiting for pending chunks before ending stream');
            setTimeout(() => endChunkStream(), 200);
            return;
          }

          if (hasReceivedFirstChunk) {
            mediaSource.endOfStream();
            logger.debug('MediaSource stream ended successfully');
          } else {
            logger.warn('Stream ended without receiving any chunks');
          }
        } catch (err) {
          logger.error('Error ending MediaSource stream', err);
        }
      }

      // Clean up audio element and URL
      audio.onended = null;

      // Remove from DOM if we added it
      if (audio.parentNode) {
        audio.parentNode.removeChild(audio);
      }

      if (this.currentAudioUrl === url) {
        this.currentAudioUrl = null;
        URL.revokeObjectURL(url);
      }

      // Reset references to allow garbage collection
      sourceBuffer = null;
    };

    // Set up completion handler
    audio.onended = (): void => {
      logger.debug('Audio playback completed');
      endChunkStream();
      onComplete?.();
    };

    return {
      addChunkToStream,
      endChunkStream,
    };
  }

  /**
   * Stop any ongoing HTMLAudioElement playback.
   */
  public async stopPlayback(): Promise<void> {
    if (this.currentHtmlAudio) {
      try {
        this.currentHtmlAudio.pause();
        this.currentHtmlAudio.src = '';
      } catch (err) {
        this.logger.error('Error stopping playback', err);
      }
      this.currentHtmlAudio = null;
    }
    if (this.currentAudioUrl) {
      URL.revokeObjectURL(this.currentAudioUrl);
      this.currentAudioUrl = null;
    }
  }

  /**
   * Cleans up all audio playback resources.
   */
  public cleanup(): void {
    this.stopPlayback();
  }
}
