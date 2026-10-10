declare module 'gifenc' {
  type Format = 'rgb565' | 'rgb444' | 'rgba4444';
  type Palette = number[][];

  function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: Format; oneBitAlpha?: boolean | number; clearAlpha?: boolean },
  ): Palette;

  function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    format?: Format,
  ): Uint8Array;

  function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: {
        palette?: Palette;
        delay?: number;
        transparent?: boolean;
        transparentIndex?: number;
        dispose?: number;
        repeat?: number;
        first?: boolean;
      },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  };

  const gifenc: {
    quantize: typeof quantize;
    applyPalette: typeof applyPalette;
    GIFEncoder: typeof GIFEncoder;
  };
  export default gifenc;
}
