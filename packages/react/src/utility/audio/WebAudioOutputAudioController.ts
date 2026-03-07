/*
 * Web Audio API implementation of the OutputAudioController interface.
 * ---------------------------------------------------------------------
 * **PCM streaming variant – byte‑accurate**
 * Handles raw 16‑bit little‑endian PCM from ElevenLabs (`pcm_24000`).  The
 * byte‑level buffer realigns odd‑sized packets before converting to
 * `AudioBuffer`s, eliminating white‑noise artefacts. Implements all methods
 * required by `OutputAudioController`.
 */

import {
  OutputAudioController,
  PlayAudioParams,
  InitializeChunkStreamParams,
} from './OutputAudioController';

// ─── PCM constants ─────────────────────────────────────────────────────
const STREAM_SAMPLE_RATE = 24_000; // match ElevenLabs request
const CHANNELS = 1; // mono
const SLICE_DURATION_S = 0.25; // schedule 250ms
const FRAMES_PER_SLICE = Math.floor(STREAM_SAMPLE_RATE * SLICE_DURATION_S);
const BYTES_PER_SLICE = FRAMES_PER_SLICE * 2; // 16‑bit → 2B per frame

/** Scheduler jitter window (seconds). */
const SCHED_TOLERANCE = 0.05;

export class WebAudioOutputAudioController extends OutputAudioController {
  private readonly audioCtx = new AudioContext();
  private readonly gain = this.audioCtx.createGain();

  private nextPlayTime = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private userGestureHookAttached = false;

  constructor() {
    super('@m4trix/core > WebAudioOutputAudioController');
    this.gain.connect(this.audioCtx.destination);
    this.resetScheduler();
  }

  // ─────────────────────────────────────────────────────────────────────
  // One‑shot playback
  // ─────────────────────────────────────────────────────────────────────
  public async playAudio({
    source,
    onComplete,
  }: PlayAudioParams): Promise<void> {
    await this.stopPlayback();
    const buf = await this.sourceToArrayBuffer(source);
    const decoded = await this.decode(buf);
    await this.ensureContextRunning();
    const src = this.createSource(decoded, this.audioCtx.currentTime);
    src.onended = (): void => {
      this.activeSources.delete(src);
      onComplete?.();
    };
  }

  public async playAudioStream(): Promise<void> {
    /* reserved for future MSE path */
  }

  // ─────────────────────────────────────────────────────────────────────
  // PCM streaming
  // ─────────────────────────────────────────────────────────────────────
  public async initializeChunkStream({
    onComplete,
  }: InitializeChunkStreamParams): Promise<{
    addChunkToStream: (chunk: ArrayBuffer | Blob) => Promise<void>;
    endChunkStream: () => void;
  }> {
    await this.stopPlayback();
    await this.ensureContextRunning();
    this.resetScheduler();

    let streamEnded = false;
    let pending = new Uint8Array(0); // may hold an odd byte

    const addChunkToStream = async (pkt: ArrayBuffer | Blob): Promise<void> => {
      if (streamEnded) {
        this.logger.warn('Attempt to add chunk after stream ended – ignoring.');
        return;
      }
      const bytes = new Uint8Array(
        pkt instanceof Blob ? await pkt.arrayBuffer() : pkt
      );
      if (bytes.length === 0) return;

      const merged = new Uint8Array(pending.length + bytes.length);
      merged.set(pending);
      merged.set(bytes, pending.length);
      pending = merged;

      if (pending.length % 2 === 1) return; // keep lone byte for next packet

      while (pending.length >= BYTES_PER_SLICE) {
        const sliceBytes = pending.slice(0, BYTES_PER_SLICE);
        pending = pending.slice(BYTES_PER_SLICE);

        // copy into an aligned buffer to avoid RangeError when the
        // underlying byteOffset is odd
        const aligned = sliceBytes.buffer.slice(
          sliceBytes.byteOffset,
          sliceBytes.byteOffset + sliceBytes.byteLength
        );
        const int16 = new Int16Array(aligned);
        const buf = this.audioCtx.createBuffer(
          CHANNELS,
          int16.length,
          STREAM_SAMPLE_RATE
        );
        const data = buf.getChannelData(0);
        for (let i = 0; i < int16.length; i++) data[i] = int16[i] / 32768;
        this.scheduleBuffer(buf);
      }
    };

    const endChunkStream = (): void => {
      if (streamEnded) return;
      streamEnded = true;
      if (onComplete) {
        if (this.activeSources.size === 0) onComplete();
        else {
          const last = Array.from(this.activeSources).pop();
          if (last) {
            const prev = last.onended;
            last.onended = (e): void => {
              if (prev) prev.call(last, e);
              onComplete();
            };
          }
        }
      }
    };

    return { addChunkToStream, endChunkStream };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Buffer scheduling helpers
  // ─────────────────────────────────────────────────────────────────────
  private scheduleBuffer(buf: AudioBuffer): void {
    if (this.nextPlayTime < this.audioCtx.currentTime + SCHED_TOLERANCE) {
      this.nextPlayTime = this.audioCtx.currentTime + SCHED_TOLERANCE;
    }
    this.createSource(buf, this.nextPlayTime);
    this.nextPlayTime += buf.duration;
  }

  private createSource(buf: AudioBuffer, when: number): AudioBufferSourceNode {
    const src = this.audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start(when);
    this.activeSources.add(src);
    src.onended = (): void => {
      this.activeSources.delete(src);
    };
    return src;
  }

  private resetScheduler(): void {
    this.nextPlayTime = this.audioCtx.currentTime;
  }

  // ─── External resource helpers ───────────────────────────────────────
  private sourceToArrayBuffer(src: Blob | string): Promise<ArrayBuffer> {
    return typeof src === 'string'
      ? fetch(src).then((r) => {
          if (!r.ok) throw new Error(`${r.status}`);
          return r.arrayBuffer();
        })
      : src.arrayBuffer();
  }

  private decode(buf: ArrayBuffer): Promise<AudioBuffer> {
    return new Promise((res, rej) =>
      this.audioCtx.decodeAudioData(buf, res, rej)
    );
  }

  // ─── Lifecycle methods ───────────────────────────────────────────────
  public async stopPlayback(): Promise<void> {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {
        /* ignore */
      }
      src.disconnect();
    }
    this.activeSources.clear();
    this.resetScheduler();
  }

  public cleanup(): void {
    this.stopPlayback();
    if (this.audioCtx.state !== 'closed') this.audioCtx.close();
  }

  // ─── Autoplay‑policy helper ──────────────────────────────────────────
  private async ensureContextRunning(): Promise<void> {
    if (this.audioCtx.state !== 'suspended') return;

    try {
      await this.audioCtx.resume();
    } catch {
      /* ignore */
    }
    if ((this.audioCtx.state as string) === 'running') return;

    if (!this.userGestureHookAttached) {
      this.userGestureHookAttached = true;
      const resume = async (): Promise<void> => {
        try {
          await this.audioCtx.resume();
        } catch {
          /* ignore */
        }
        if (this.audioCtx.state === 'running')
          document.removeEventListener('click', resume);
      };
      document.addEventListener('click', resume);
    }
  }
}
