import { describe, it, expect, vi } from 'vitest';
import { Pump } from './Pump';

describe('Pump', () => {
  describe('from', () => {
    it('should convert an AsyncIterable to a Pump', async () => {
      // Create an async iterable source
      async function* source(): AsyncGenerator<string> {
        yield 'a';
        yield 'b';
        yield 'c';
      }

      // Convert to a Pump
      const pump = Pump.from(source());

      // Collect results using map and drain
      const results: string[] = [];
      await pump
        .map((data) => {
          results.push(data);
          return data;
        })
        .drain();

      // Verify
      expect(results).toEqual(['a', 'b', 'c']);
    });
  });

  describe('map', () => {
    it('should transform each data value', async () => {
      // Create a pump with some data
      async function* source(): AsyncGenerator<number> {
        yield 1;
        yield 2;
        yield 3;
      }

      // Use map to transform data
      const results: number[] = [];
      await Pump.from(source())
        .map((num) => num * 2)
        .map((doubled) => {
          results.push(doubled);
          return doubled;
        })
        .drain();

      // Verify
      expect(results).toEqual([2, 4, 6]);
    });

    it('should work with undefined values that are not end of stream', async () => {
      // Create a pump with some data
      async function* source(): AsyncGenerator<number | undefined> {
        yield 1;
        yield undefined;
        yield 3;
        yield 4;
      }

      // Use map to transform data
      const results: number[] = [];
      await Pump.from(source())
        .map((num) => (num ? num : 0) * 2)
        .map((doubled) => {
          results.push(doubled);
          return doubled;
        })
        .drain();

      // Verify
      expect(results).toEqual([2, 0, 6, 8]);
    });
  });

  describe('onChunk', () => {
    it('should perform side effects without altering the stream', async () => {
      // Create a pump with some data
      async function* source(): AsyncGenerator<string> {
        yield 'test1';
        yield 'test2';
      }

      // Side effect counter
      let callCount = 0;

      // Collect results while performing side effect
      const results: string[] = [];
      await Pump.from(source())
        .onChunk(() => {
          // Count each chunk
          callCount++;
        })
        .map((data) => {
          results.push(data);
          return data;
        })
        .drain();

      // Verify data was unchanged
      expect(results).toEqual(['test1', 'test2']);
      // Verify side effect occurred for each chunk
      expect(callCount).toBe(2);
    });
  });

  describe('batch', () => {
    it('should batch items into arrays of specified size', async () => {
      // Create a pump with some data
      async function* source(): AsyncGenerator<number> {
        yield 1;
        yield 2;
        yield 3;
        yield 4;
        yield 5;
      }

      // Collect batched results
      const results: number[][] = [];
      await Pump.from(source())
        .batch(2)
        .map((batchedData) => {
          results.push(batchedData);
          return batchedData;
        })
        .drain();

      // Verify batches are created correctly, including the final partial batch
      expect(results).toEqual([[1, 2], [3, 4], [5]]);
    });
  });

  describe('fork', () => {
    it('should create two independent consumers of the same stream', async () => {
      // Create a pump with some data
      async function* source(): AsyncGenerator<string> {
        yield 'a';
        yield 'b';
        yield 'c';
      }

      // Fork the stream
      const [stream1, stream2] = Pump.from(source()).fork();

      // Collect results from both streams
      const results1: string[] = [];
      const results2: string[] = [];

      // Process both streams concurrently
      await Promise.all([
        stream1
          .map((data) => {
            results1.push(data);
            return data;
          })
          .drain(),
        stream2
          .map((data) => {
            results2.push(data);
            return data;
          })
          .drain(),
      ]);

      // Verify both streams received the same data
      expect(results1).toEqual(['a', 'b', 'c']);
      expect(results2).toEqual(['a', 'b', 'c']);
    });
  });

  describe('drain', () => {
    it('should drain without a transformer', async () => {
      // Create a pump with some data
      async function* source(): AsyncGenerator<string> {
        yield 'a';
        yield 'b';
      }

      // Just drain the stream
      const drainPromise = Pump.from(source()).drain();

      // Verify that drain returns a promise that resolves
      await expect(drainPromise).resolves.toBeUndefined();
    });
  });

  describe('drainTo', () => {
    it('should drain the stream to a transformer', async () => {
      // Create a pump with some data
      async function* source(): AsyncGenerator<string> {
        yield 'item1';
        yield 'item2';
      }

      // Create a mock transformer
      const results: string[] = [];
      const transformer = {
        transform: (data: string): string => {
          results.push(data);
          return data;
        },
        close: vi.fn(),
        response: new Response(),
      };

      // Use an awaitable pattern instead of setTimeout
      const transformerPromise = new Promise<void>((resolve) => {
        const originalClose = transformer.close;
        transformer.close = vi.fn(() => {
          originalClose.call(transformer);
          resolve();
        });
      });

      // Use drainTo with the transformer
      Pump.from(source()).drainTo(transformer);

      // Wait for transformer to complete
      await transformerPromise;

      // Verify data was sent to the transformer
      expect(results).toEqual(['item1', 'item2']);
      // Verify close was called
      expect(transformer.close).toHaveBeenCalled();
    });
  });

  describe('filter', () => {
    it('should filter items based on a predicate', async () => {
      // Create a pump with some data
      async function* source(): AsyncGenerator<number> {
        yield 1;
        yield 2;
        yield 3;
      }

      // Filter even numbers
      const results: number[] = [];
      await Pump.from(source())
        .filter((num) => num % 2 === 0)
        .map((num) => {
          results.push(num);
          return num;
        })
        .drain();

      // Verify only even numbers were emitted
      expect(results).toEqual([2]);
    });
  });

  describe('bundle', () => {
    it('should bundle items based on a condition', async () => {
      // Create a pump with some data - words to be bundled into lines
      async function* source(): AsyncGenerator<number> {
        yield 5;
        yield 5;
        yield 5;
        yield 5;
        yield 5;
      }

      // Bundle words until total length exceeds 10 characters
      const results: number[][] = [];

      await Pump.from(source())
        .bundle((data, accumulated) => {
          // Note: when this returns true, the current word starts a new bundle
          // The current word is NOT added to the current bundle before closing

          // If the buffer is empty, don't close it yet
          if (accumulated.length === 0) {
            return false;
          }

          // Calculate total length of current bundle including spaces
          const totalSum = accumulated.reduce((sum, w) => sum + w, 0);

          // Close bundle if adding this word would exceed 10 chars
          // This word will start the next bundle
          return totalSum + data >= 15;
        })
        .map((bundle) => {
          results.push(bundle);
          return bundle;
        })
        .drain();

      // Verify bundles were created correctly
      expect(results).toEqual([
        [5, 5, 5],
        [5, 5],
      ]);
    });

    it('should emit accumulated items when stream is done', async () => {
      // Create a pump with some data
      async function* source(): AsyncGenerator<number> {
        yield 1;
        yield 2;
        yield 3;
      }

      // Track if all items were seen in the stream
      const seenItems = new Set<number>();
      const results: number[][] = [];

      // Force the bundle to be emitted at the end by adding a final step
      await Pump.from(source())
        .map((num) => {
          seenItems.add(num);
          return num;
        })
        .bundle(() => false) // Never close bundle based on condition
        .map((bundle) => {
          results.push(bundle);
          return bundle;
        })
        .drain();

      // Verify the final bundle contains all items
      expect(results.length).toBe(1);
      expect(results[0]).toEqual([1, 2, 3]);

      // Verify all items were processed
      expect(seenItems.size).toBe(3);
      expect(seenItems.has(1)).toBe(true);
      expect(seenItems.has(2)).toBe(true);
      expect(seenItems.has(3)).toBe(true);
    });

    it('should handle empty stream correctly', async () => {
      // Create an empty pump
      async function* source(): AsyncGenerator<number> {
        // No yields - empty stream
      }

      const results: number[][] = [];

      await Pump.from(source())
        .bundle((_, accumulated) => accumulated.length >= 2)
        .map((bundle) => {
          results.push(bundle);
          return bundle;
        })
        .drain();

      // Test should verify that an empty stream produces no bundles
      expect(results).toEqual([]);
    });
  });

  describe('buffer', () => {
    it('should buffer chunks until the buffer is filled', async () => {
      // Create a pump with some data
      async function* source(): AsyncGenerator<number> {
        yield 1;
        yield 2;
        yield 3;
        yield 4;
        yield 5;
      }

      // Track the order of received chunks
      const receivedChunks: number[] = [];
      const bufferSize = 3;

      // Use a mock to track when chunks are processed

      await Pump.from(source())
        .buffer(bufferSize)
        .map((num) => {
          receivedChunks.push(num);
          return num;
        })
        .drain();

      // Verify all chunks were received
      expect(receivedChunks).toEqual([1, 2, 3, 4, 5]);
    });

    it('should drain buffer immediately when done chunk is received', async () => {
      // Create a pump with some data that ends before buffer is filled
      async function* source(): AsyncGenerator<number> {
        yield 1;
        yield 2; // Buffer size is 3, but we only have 2 items
      }

      const receivedChunks: number[] = [];

      await Pump.from(source())
        .buffer(3) // Buffer size larger than our data
        .map((num) => {
          receivedChunks.push(num);
          return num;
        })
        .drain();

      // Verify all chunks were received despite buffer not being filled
      expect(receivedChunks).toEqual([1, 2]);
    });
  });

  describe('slidingWindow', () => {
    it('should correctly spit out the windows', async () => {
      // Create a pump with 10 numbers
      async function* source(): AsyncGenerator<number> {
        for (let i = 1; i <= 10; i++) {
          yield i;
        }
      }

      // Collect the windows
      const windows: (number | undefined)[][] = [];
      const windowSize = 3;

      await Pump.from(source())
        .slidingWindow(windowSize, 1)
        .map((window) => {
          windows.push([...window]); // Make a copy to avoid reference issues
          return window;
        })
        .drain();

      // Verify the windows
      expect(windows.length).toBe(12);

      // First window should have only the first element defined
      expect(windows[0][0]).toBe(1);
      expect(windows[0][1]).toBeUndefined();
      expect(windows[0][2]).toBeUndefined();

      // Second window should have first two elements defined
      expect(windows[1][0]).toBe(2);
      expect(windows[1][1]).toBe(1);
      expect(windows[1][2]).toBeUndefined();

      // Third window should have all elements defined
      expect(windows[2][0]).toBe(3);
      expect(windows[2][1]).toBe(2);
      expect(windows[2][2]).toBe(1);

      // Middle windows should all be fully defined
      expect(windows[5]).toEqual([6, 5, 4]);

      // Last window should be fully defined
      expect(windows[9]).toEqual([10, 9, 8]);

      expect(windows[10]).toEqual([undefined, 10, 9]);
      expect(windows[11]).toEqual([undefined, undefined, 10]);
    });

    it('should correctly roll over text', async () => {
      async function* source(): AsyncGenerator<string> {
        yield 'Hello';
        yield 'my fellow';
        yield 'friend';
        yield 'this rolling window';
        yield 'is a bit more confusing logic';
      }

      // Collect the windows
      const windows: (string | undefined)[][] = [];
      const windowSize = 2;

      await Pump.from(source())
        .slidingWindow(windowSize, 1)
        .map((window) => {
          windows.push([...window]); // Make a copy to avoid reference issues
          return window;
        })
        .drain();

      // Verify the windows
      expect(windows.length).toBe(6);

      // First window should have only the first element defined
      expect(windows[0][0]).toBe('Hello');
      expect(windows[0][1]).toBeUndefined();

      // Second window should have first two elements defined
      expect(windows[1][0]).toBe('my fellow');
      expect(windows[1][1]).toBe('Hello');

      // Third window should have all elements defined
      expect(windows[2]).toEqual(['friend', 'my fellow']);

      // Middle windows should all be fully defined
      expect(windows[3]).toEqual(['this rolling window', 'friend']);

      expect(windows[4]).toEqual([
        'is a bit more confusing logic',
        'this rolling window',
      ]);

      expect(windows[5]).toEqual([undefined, 'is a bit more confusing logic']);
    });
  });

  describe('onClose', () => {
    it('should collect all chunks and run callback when stream is done', async () => {
      // Setup a simple source stream
      async function* source(): AsyncGenerator<number> {
        yield 1;
        yield 2;
        yield 3;
        yield 4;
        yield 5;
      }

      // Create a variable to store the collected items
      let collectedItems: number[] = [];

      // Use onClose to collect all items
      await Pump.from(source())
        .onClose((history) => {
          collectedItems = history;
        })
        .drain();

      // Verify all items were collected
      expect(collectedItems).toEqual([1, 2, 3, 4, 5]);
    });

    it('should allow multiple onClose calls to capture different transformations', async () => {
      // Setup a source stream
      async function* source(): AsyncGenerator<number> {
        yield 1;
        yield 2;
        yield 3;
      }

      // Create variables to store different collected items
      let originalNumbers: number[] = [];
      let doubledNumbers: number[] = [];
      let stringifiedNumbers: string[] = [];

      // Create a pump with multiple transformations and onClose handlers
      await Pump.from(source())
        .onClose((history) => {
          originalNumbers = history;
        })
        .map((n) => n * 2)
        .onClose((history) => {
          doubledNumbers = history;
        })
        .map((n) => `Number: ${n}`)
        .onClose((history) => {
          stringifiedNumbers = history;
        })
        .drain();

      // Verify each onClose captured the correct transformation state
      expect(originalNumbers).toEqual([1, 2, 3]);
      expect(doubledNumbers).toEqual([2, 4, 6]);
      expect(stringifiedNumbers).toEqual([
        'Number: 2',
        'Number: 4',
        'Number: 6',
      ]);
    });

    it('should handle async callbacks in onClose', async () => {
      // Setup a source stream
      async function* source(): AsyncGenerator<string> {
        yield 'a';
        yield 'b';
        yield 'c';
      }

      // Create a variable to store the result of async processing
      let asyncResult = '';

      // Use an async callback in onClose
      await Pump.from(source())
        .onClose(async (history) => {
          // Simulate async processing
          await new Promise((resolve) => setTimeout(resolve, 10));
          asyncResult = history.join('-');
        })
        .drain();

      // Verify the async callback completed
      expect(asyncResult).toBe('a-b-c');
    });
  });
});
