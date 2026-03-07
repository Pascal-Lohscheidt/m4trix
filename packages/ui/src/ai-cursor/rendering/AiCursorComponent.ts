import { LitElement, PropertyValues, TemplateResult, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { createRef, ref } from 'lit/directives/ref.js';
import { createTimeline, Timeline } from 'animejs';
import { AiCursorComponentStyle } from './AiCursorComponent.style';

export type Props = {
  /**
   * The event hooks are functions that let you connect the inner logic of the solid js component and the AiCursor Class that acts
   * as an API.
   */
  eventHooks: {
    defineSetPosition: (fn: (position: [number, number]) => void) => void;
    defineAddPositionToQueue: (
      fn: (position: [number, number]) => void
    ) => void;
    definePlayQueue: (fn: () => void) => void;
    defineSetShowCursor: (fn: (show: boolean) => void) => void;
  };
};

@customElement('ai-cursor')
export class AiCursorComponent extends LitElement {
  @property({
    type: Object,
  })
  eventHooks: Props['eventHooks'] = {
    defineSetPosition: () => {},
    defineAddPositionToQueue: () => {},
    definePlayQueue: () => {},
    defineSetShowCursor: () => {},
  };

  @property({ type: Boolean })
  isShowingCursor = true;
  @property({ type: String })
  labelText = 'AI Cursor';

  @property({ type: Array })
  cursorPosition: [number, number] = [0, 0];

  private _timeline: Timeline | undefined;

  @state()
  private _cursorRef = createRef<HTMLSpanElement>();
  @state()
  private _labelRef = createRef<HTMLSpanElement>();

  constructor() {
    super();
  }

  updated(_changedProperties: PropertyValues): void {
    if (_changedProperties.has('_cursorRef')) {
      if (this._cursorRef.value) {
        this.hookUpCallbacks();
      } else {
        this._timeline?.pause();
        this._timeline?.refresh();
      }
    }
    super.updated(_changedProperties);
  }

  // Define scoped styles right with your component, in plain CSS
  static styles = AiCursorComponentStyle;

  render(): TemplateResult {
    const cursorSvg = html`
      <svg
        width=${24}
        height=${24}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <g clip-path="url(#clip0_3576_285)">
          <path
            class="cursor-path"
            d="M2.14849 7.04749C1.35153 4.07321 4.07319 1.35155 7.04747 2.14851L77.3148 20.9766C80.2891 21.7735 81.2853 25.4914 79.108 27.6687L27.6687 79.108C25.4914 81.2853 21.7735 80.2891 20.9766 77.3149L2.14849 7.04749Z"
            fill="currentColor"
          />
        </g>
        <defs>
          <clipPath id="clip0_3576_285">
            <rect width="100" height="100" fill="white" />
          </clipPath>
        </defs>
      </svg>
    `;

    return html`
      <span
        id="cursor-graphic-parent"
        ${ref(this._cursorRef)}
        ?hidden=${!this.isShowingCursor}
      >
        ${cursorSvg}
        <span
          ${ref(this._labelRef)}
          id="label-text"
          ?hidden=${!this.isShowingCursor}
          >${this.labelText}</span
        >
      </span>
    `;
  }

  // private methods

  /**
   * The primary way to control the cursor is using an external API.
   * This interface exposes controlling methods. The Lit Component itself is
   * intended to be a controlled component.
   */
  private hookUpCallbacks(): void {
    const animationTarget = this._cursorRef.value;

    if (!animationTarget) {
      return;
    }

    this._timeline = createTimeline({ defaults: { duration: 750 } });

    if (!this._timeline) {
      return;
    }

    this.eventHooks.defineSetPosition((position) => {
      this._timeline?.add(animationTarget, {
        translateX: position[0],
        translateY: position[1],
        duration: 1,
      });
      this._timeline?.play();
    });

    this.eventHooks.defineAddPositionToQueue((position) => {
      this._timeline?.add(animationTarget, {
        translateX: position[0],
        translateY: position[1],
        duration: 1000,
      });
    });

    this.eventHooks.defineSetShowCursor((show) => {
      this.isShowingCursor = show;
    });

    this.eventHooks.definePlayQueue(() => {
      this._timeline?.play();
    });
  }

  // Getters
  get cursorRef(): HTMLSpanElement | undefined {
    return this._cursorRef.value;
  }

  get labelRef(): HTMLSpanElement | undefined {
    return this._labelRef.value;
  }
}
