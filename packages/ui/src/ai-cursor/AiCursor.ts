import { mountAiCursor } from './rendering';
import { Props as AiCursorProps } from './rendering/AiCursorComponent';

type Selector = string;
type CursorTarget = HTMLElement | Selector | [number, number];

/**
 * The AiCursor is a class that is used to create a cursor element and acts an interface to control the cursor.
 * It is used to move the cursor to a target, show or hide the cursor, and to schedule moves.
 *
 * @example
 * ```ts
 * const cursor = AiCursor.spawn();
 * cursor.moveTo('#target-element');
 * ```
 *
 * @author @Pascal-Lohscheidt
 */
export class AiCursor {
  private setPosition?: (position: [number, number]) => void;
  private addPositionToQueue?: (position: [number, number]) => void;
  private playQueue?: () => void;
  private setShowCursor?: (show: boolean) => void;

  constructor() {}

  // Static constructors
  static spawn(): AiCursor {
    const newCursor = new AiCursor();
    newCursor.mount();
    return newCursor;
  }

  jumpTo(target: CursorTarget): void {
    const position = targetToPosition(target);
    if (position) {
      this.setPosition?.(position);
    }
  }

  moveTo(target: CursorTarget): void {
    const position = targetToPosition(target);
    if (position) {
      this.addPositionToQueue?.(position);
      this.playQueue?.();
    }
  }

  scheduleMoves(targets: CursorTarget[]): void {
    targets.forEach((target) => {
      const position = targetToPosition(target);
      if (position) {
        this.addPositionToQueue?.(position);
      }
    });
    this.playQueue?.();
  }

  show(): void {
    this.setShowCursor?.(true);
  }

  hide(): void {
    this.setShowCursor?.(false);
  }

  private mount(): void {
    mountAiCursor({
      eventHooks: {
        defineSetPosition: (callback): void => {
          this.setPosition = callback;
        },
        defineAddPositionToQueue: (callback): void => {
          this.addPositionToQueue = callback;
        },
        definePlayQueue: (callback): void => {
          this.playQueue = callback;
        },
        defineSetShowCursor: (callback): void => {
          this.setShowCursor = callback;
        },
      },
    } satisfies AiCursorProps);
  }
}

function calculateClickPositionFromElement(element: Element): [number, number] {
  const rect = element.getBoundingClientRect();
  return [rect.left + rect.width / 2, rect.top + rect.height / 2];
}

function targetToPosition(target: CursorTarget): [number, number] | undefined {
  if (
    Array.isArray(target) &&
    target.length === 2 &&
    typeof target[0] === 'number' &&
    typeof target[1] === 'number'
  ) {
    return target;
  } else if (target instanceof HTMLElement) {
    return calculateClickPositionFromElement(target);
  } else if (typeof target === 'string') {
    const element = document.querySelector(target);
    if (element) {
      return calculateClickPositionFromElement(element);
    }
  }
  return undefined;
}
