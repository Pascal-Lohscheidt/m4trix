'use client';

import {
  AppWindowIcon,
  ArchiveIcon,
  DatabaseIcon,
  FolderSimpleIcon,
  type Icon,
  ShippingContainerIcon,
  TreeStructureIcon,
} from '@phosphor-icons/react';
import { createTimeline, onScroll, utils } from 'animejs';
import { useRef } from 'react';
import { useAnimeScope } from './useAnimeScope';

function Node({
  id,
  icon: NodeIcon,
  title,
  detail,
}: {
  id: string;
  icon: Icon;
  title: string;
  detail: string;
}) {
  return (
    <div data-node={id} className="gfx-node gap-3 py-2.5">
      <span className="gfx-fill" />
      <NodeIcon aria-hidden className="relative h-4 w-4 shrink-0 text-(--accent)" />
      <span className="relative flex min-w-0 flex-col">
        <span className="truncate text-[12.5px] text-text-1">{title}</span>
        <span className="truncate text-[11px] text-text-3">{detail}</span>
      </span>
    </div>
  );
}

function InnerFlow({ id }: { id: string }) {
  return (
    <div className="gfx-flow-track mx-auto my-1.5 h-5 w-[2px]">
      <span data-flow={id} className="gfx-flow" />
    </div>
  );
}

function ZoneFlow({ id }: { id: string }) {
  return (
    <div className="gfx-flow-track gfx-flow-x mx-auto h-8 w-[2px] self-center lg:h-[2px] lg:w-full">
      <span data-flow={id} className="gfx-flow" />
    </div>
  );
}

function Zone({
  title,
  caption,
  children,
}: {
  title: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-(--border-md) bg-[color-mix(in_srgb,var(--bg-raised)_45%,transparent)] p-5">
      <h3 className="font-display text-[17px] font-semibold text-text-1">{title}</h3>
      <div className="mt-4 flex flex-col">{children}</div>
      <p className="mt-5 text-[14px] leading-relaxed text-text-2">{caption}</p>
    </div>
  );
}

export default function ShipGraphic() {
  const root = useRef<HTMLDivElement>(null);

  useAnimeScope(root, (el) => {
    const q = (sel: string) => el.querySelectorAll(sel);
    const fill = (id: string) => q(`[data-node="${id}"] .gfx-fill`);
    const flow = (id: string) => q(`[data-flow="${id}"]`);
    const allFills = q('.gfx-fill');
    const allFlows = q('[data-flow]');
    const orders = q('[data-order]');
    utils.set(allFills, { opacity: 0 });
    utils.set(allFlows, { '--p': 0 });
    utils.set(orders, { opacity: 0.35 });

    const on = { opacity: [0, 1], duration: 320 };
    const run = { '--p': [0, 1], duration: 520, ease: 'inOut(2)' };

    createTimeline({
      loop: true,
      defaults: { ease: 'out(3)' },
      autoplay: onScroll({ target: el, enter: 'bottom top', leave: 'top bottom' }),
    })
      .add(fill('app'), on, 400)
      .add(flow('write'), run)
      .add(fill('volume'), on)
      .add(flow('pickup'), run, '+=200')
      .add(fill('sidecar'), on)
      .add(orders[0], { opacity: 1, duration: 300 }, '+=150')
      .add(flow('ship'), run)
      .add(fill('s3'), on)
      .add(orders[1], { opacity: 1, duration: 300 }, '+=300')
      .add(fill('dynamo'), on)
      .add(flow('read'), run, '+=200')
      .add(fill('viewer'), on)
      .add(allFills, { opacity: 0, duration: 500 }, '+=2400')
      .add(allFlows, { '--p': 0, duration: 500 }, '<<')
      .add(orders, { opacity: 0.35, duration: 500 }, '<<');
  });

  return (
    <div ref={root} className="grid gap-0 lg:grid-cols-[1fr_3.5rem_1fr_3.5rem_1fr] lg:gap-0">
      <Zone
        title="Write locally"
        caption="Filesystem adapters write to a folder. On a laptop that is the whole setup."
      >
        <Node id="app" icon={AppWindowIcon} title="Your app" detail="Tracer + Fs adapters" />
        <InnerFlow id="write" />
        <Node
          id="volume"
          icon={FolderSimpleIcon}
          title="/traces"
          detail="trace.json, runs.ndjson"
        />
      </Zone>

      <ZoneFlow id="pickup" />

      <Zone
        title="Ship with a sidecar"
        caption="A companion container uploads payloads before structure, so the app needs no AWS credentials."
      >
        <Node
          id="sidecar"
          icon={ShippingContainerIcon}
          title="Sidecar"
          detail="m4trix-tracing-sidecar"
        />
        <div className="mt-3 flex flex-wrap gap-2 font-mono text-[11px]">
          <span data-order className="tool-chip text-(--accent-text)">
            payloads first
          </span>
          <span data-order className="tool-chip text-(--accent-text)">
            structure after
          </span>
        </div>
      </Zone>

      <ZoneFlow id="ship" />

      <Zone
        title="Read from AWS"
        caption="The same viewer and MCP server read straight from your account."
      >
        <div className="grid grid-cols-2 gap-2">
          <Node id="s3" icon={ArchiveIcon} title="S3" detail="payloads" />
          <Node id="dynamo" icon={DatabaseIcon} title="DynamoDB" detail="structure" />
        </div>
        <InnerFlow id="read" />
        <Node id="viewer" icon={TreeStructureIcon} title="Viewer" detail="--adapter aws-stack" />
      </Zone>
    </div>
  );
}
