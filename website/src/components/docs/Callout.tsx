import {
  CheckCircleIcon,
  InfoIcon,
  LightbulbIcon,
  WarningIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

export type CalloutKind = 'note' | 'info' | 'tip' | 'warning' | 'check';

const ICONS = {
  note: InfoIcon,
  info: InfoIcon,
  tip: LightbulbIcon,
  warning: WarningIcon,
  check: CheckCircleIcon,
} as const;

export function Callout({
  kind = 'note',
  title,
  children,
}: {
  kind?: CalloutKind;
  title?: ReactNode;
  children: ReactNode;
}) {
  const Icon = ICONS[kind];
  return (
    <div className={`docs-callout docs-callout-${kind}`} role="note">
      <Icon aria-hidden weight="duotone" className="docs-callout-icon" />
      <div className="docs-callout-body">
        {title ? <p className="docs-callout-title">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}

export const Note = (props: { title?: string; children: ReactNode }) => (
  <Callout kind="note" {...props} />
);
export const Info = (props: { title?: string; children: ReactNode }) => (
  <Callout kind="info" {...props} />
);
export const Tip = (props: { title?: string; children: ReactNode }) => (
  <Callout kind="tip" {...props} />
);
export const Warning = (props: { title?: string; children: ReactNode }) => (
  <Callout kind="warning" {...props} />
);
export const Check = (props: { title?: string; children: ReactNode }) => (
  <Callout kind="check" {...props} />
);
