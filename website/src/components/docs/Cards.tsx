import type { Icon } from '@phosphor-icons/react';
import {
  ArrowRightIcon,
  BroadcastIcon,
  BrowserIcon,
  ClipboardTextIcon,
  FactoryIcon,
  FlowArrowIcon,
  GitBranchIcon,
  GraphIcon,
  HardDrivesIcon,
  PathIcon,
  PlugIcon,
  PulseIcon,
  RobotIcon,
  SignpostIcon,
  SparkleIcon,
} from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';
import type { ReactNode } from 'react';

/** Content uses Mintlify / Lucide icon names; map them onto Phosphor. */
const ICONS: Record<string, Icon> = {
  activity: PulseIcon,
  bot: RobotIcon,
  'clipboard-check': ClipboardTextIcon,
  factory: FactoryIcon,
  'git-branch': GitBranchIcon,
  network: GraphIcon,
  'panel-top': BrowserIcon,
  plug: PlugIcon,
  radio: BroadcastIcon,
  route: PathIcon,
  server: HardDrivesIcon,
  sparkles: SparkleIcon,
  waypoints: SignpostIcon,
  workflow: FlowArrowIcon,
};

export function Columns({ cols = 2, children }: { cols?: number; children: ReactNode }) {
  return (
    <div className="docs-columns not-prose" style={{ '--cols': cols } as React.CSSProperties}>
      {children}
    </div>
  );
}

export function Card({
  title,
  icon,
  href,
  children,
}: {
  title: string;
  icon?: string;
  href?: string;
  children?: ReactNode;
}) {
  const IconComponent = icon ? ICONS[icon] : undefined;
  const content = (
    <>
      <span className="docs-card-head">
        {IconComponent ? (
          <span className="docs-card-icon">
            <IconComponent aria-hidden weight="duotone" className="h-[18px] w-[18px]" />
          </span>
        ) : null}
        <span className="docs-card-title">{title}</span>
        {href ? <ArrowRightIcon aria-hidden className="docs-card-arrow h-3.5 w-3.5" /> : null}
      </span>
      {children ? <span className="docs-card-body">{children}</span> : null}
    </>
  );
  if (!href) return <div className="docs-card">{content}</div>;
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) {
    return (
      <a href={href} className="docs-card" target="_blank" rel="noreferrer">
        {content}
      </a>
    );
  }
  return (
    <Link href={href} className="docs-card">
      {content}
    </Link>
  );
}
