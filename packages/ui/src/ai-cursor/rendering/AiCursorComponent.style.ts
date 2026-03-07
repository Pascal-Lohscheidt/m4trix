import { css } from 'lit';

export const AiCursorComponentStyle = css`
  :host {
    --ai-local-cursor-size: var(--sk-ai-cursor-size, 1rem);
    --ai-local-cursor-label-padding: var(
      --sk-ai-cursor-label-padding,
      0.25rem 0.25rem
    );
    --ai-local-cursor-border-radius: var(--sk-ai-cursor-border-radius, 0.25rem);
    --ai-local-label-offset: var(--sk-ai-cursor-label-offset, 1rem);

    --ai-local-label-font-size: var(--sk-ai-cursor-label-font-size, 12px);
    --ai-local-label-font-weight: var(--sk-ai-cursor-label-font-weight, bold);
    --ai-local-label-color: var(--sk-ai-cursor-label-color, white);
    --ai-local-label-background-color: var(
      --sk-ai-cursor-label-background-color,
      black
    );
    --ai-local-label-border-color: var(
      --sk-ai-cursor-label-border-color,
      white
    );
    --ai-local-label-border-width: var(
      --sk-ai-cursor-label-border-width,
      0.1rem
    );

    color: black;
    stroke: white;
    position: absolute;
    /* Insetting in the parent element (body) */
    top: 0;
    left: 0;
    bottom: 0;
    right: 0;
    pointer-events: none;
    width: var(--ai-local-cursor-size);
    height: var(--ai-local-cursor-size);
  }

  #cursor-graphic-parent {
    position: absolute;
    top: 0;
    left: 0;
  }

  #label-text {
    position: absolute;
    color: white;
    font-size: 12px;
    font-weight: bold;
    padding: var(--ai-local-cursor-label-padding);
    border-radius: var(--ai-local-cursor-border-radius);

    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;

    width: fit-content;
    min-width: fit-content;
    top: var(--ai-local-label-offset);
    left: var(--ai-local-label-offset);

    border: var(--ai-local-label-border-width) solid
      var(--ai-local-label-border-color);
    background-color: var(--ai-local-label-background-color);
    color: var(--ai-local-label-color);
    font-size: var(--ai-local-label-font-size);
    font-weight: var(--ai-local-label-font-weight);
  }
`;
