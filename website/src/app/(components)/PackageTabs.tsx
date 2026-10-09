'use client';

import {
  ArrowsLeftRightIcon,
  CloudCheckIcon,
  CodeIcon,
  ShieldCheckIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react';
import type { PackageId } from '@/lib/packages';
import AgentsLanding from './AgentsLanding';
import { BentoIcon } from './BentoIcon';
import EvalsPrimitivesExplorer from './EvalsPrimitivesExplorer';
import EvalsRunVisual from './EvalsRunVisual';
import TracingLanding from './TracingLanding';

interface BentoItem {
  icon: React.ReactNode | string;
  title: string;
  desc: React.ReactNode;
  code?: string;
  tag?: string;
}

function BentoItemIcon({ icon }: { icon: React.ReactNode | string }) {
  if (typeof icon === 'string') {
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center text-lg leading-none">
        {icon}
      </span>
    );
  }
  return icon;
}

function InstallBlock({ pkg }: { pkg: string }) {
  return (
    <div className="install-block w-full max-w-[400px]">
      <div className="install-block-hdr">
        <span>Terminal</span>
        <span>bash</span>
      </div>
      <div className="install-block-body">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-(--accent) transition-[color] duration-300">$</span>
          <span className="min-w-0 font-mono text-text-1">
            pnpm add <span className="text-(--accent) transition-[color] duration-300">{pkg}</span>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-5">
          <span className="font-mono text-success">✓</span>
          <span className="font-mono text-success/85">Done in 0.4s</span>
        </div>
      </div>
    </div>
  );
}

function BentoGrid({ items }: { items: BentoItem[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <div key={item.title} className="bcard">
          <div className="bcard-hdr">
            <BentoItemIcon icon={item.icon} />
            <h3 className="bcard-title">{item.title}</h3>
          </div>
          <p className="text-[13px] leading-relaxed text-text-2">{item.desc}</p>
          {item.code ? <code className="bcard-code">{item.code}</code> : null}
          {item.tag ? <span className="bcard-tag">{item.tag}</span> : null}
        </div>
      ))}
    </div>
  );
}

function HeroGlow() {
  return (
    <>
      <div
        className="pointer-events-none absolute -top-[140px] left-[18%] h-[380px] w-[500px] rounded-full blur-[110px] transition-[background] duration-300"
        style={{ background: 'var(--glow-1)' }}
      />
      <div
        className="pointer-events-none absolute top-[35%] right-[16%] h-[280px] w-[360px] rounded-full blur-[110px] transition-[background] duration-300"
        style={{ background: 'var(--glow-2)' }}
      />
    </>
  );
}

const EVALS_HIGHLIGHTS: BentoItem[] = [
  {
    icon: <BentoIcon icon={ShieldCheckIcon} />,
    title: 'Typesafe schemas',
    desc: 'Effect Schema validates datasets, evaluators, test cases, and scores at every boundary. Mismatches fail in CI, not silently in production.',
    tag: 'typesafe',
  },
  {
    icon: <BentoIcon icon={CodeIcon} />,
    title: 'Datasets in code, no lock-in',
    desc: 'Define datasets as TypeScript. Filter by tag, path, or expression. No YAML ceremony, no proprietary format, no vendor cage.',
    tag: 'define',
  },
  {
    icon: <BentoIcon icon={ArrowsLeftRightIcon} />,
    title: 'Codegen & import',
    desc: 'Generate fixtures in any format you need, or import existing test cases from LangSmith, promptfoo, JSON, or other frameworks.',
    tag: 'codegen',
  },
  {
    icon: <BentoIcon icon={TerminalWindowIcon} />,
    title: 'CLI-first observability',
    desc: 'Run from the terminal in CI. Dump scores to Postgres, SQLite, or any sink adapter, then visualize with Grafana or Metabase.',
    tag: 'cli',
  },
  {
    icon: <BentoIcon icon={CloudCheckIcon} />,
    title: 'Free & self-hosted',
    desc: 'MIT licensed, no seat fees. Deploy on any cloud or run in CI/CD. Your eval data stays in infrastructure you control.',
    tag: 'infra',
  },
];

function EvalsSection() {
  return (
    <>
      <section className="relative z-[2] overflow-hidden py-12 pb-12 sm:py-20 sm:pb-24 lg:py-[80px] lg:pb-24">
        <HeroGlow />
        <div className="relative z-[2] mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col items-center gap-8 sm:gap-12 lg:flex-row lg:items-center">
            <div className="flex-1 text-center lg:text-left">
              <p className="eyebrow">@m4trix/evals</p>
              <h1 className="font-display text-[clamp(2.25rem,6vw,4rem)] font-bold tracking-[-0.025em] leading-[1.1] text-text-1">
                Repeatable evals for{' '}
                <span className="text-(--accent) transition-[color] duration-300">AI agents</span>
              </h1>
              <p className="mx-auto mt-4 max-w-[580px] text-[15px] leading-[1.65] text-text-2 sm:text-[17px] lg:mx-0">
                Define datasets, evaluators, and test cases as TypeScript files. The CLI discovers
                and runs them by convention, like Vitest, but for your AI outputs.
              </p>
              <div className="mt-[18px] flex flex-wrap justify-center gap-[7px] lg:justify-start">
                {['*.dataset.ts', '*.evaluator.ts', '*.run-config.ts', '*.test-case.ts'].map(
                  (f) => (
                    <span key={f} className="convention-pill">
                      {f}
                    </span>
                  ),
                )}
              </div>
              <div className="mx-auto mt-6 max-w-[400px] lg:mx-0">
                <InstallBlock pkg="@m4trix/evals" />
              </div>
              <div className="mt-7 flex flex-wrap justify-center gap-3 lg:justify-start">
                <a href="https://docs.m4trix.dev/evals" className="btn-primary group">
                  Get Started
                  <span className="opacity-0 transition group-hover:opacity-100">→</span>
                </a>
                <a href="https://github.com/Pascal-Lohscheidt/m4trix" className="btn-secondary">
                  View on GitHub
                </a>
              </div>
            </div>
            <div className="w-full max-w-[280px] shrink-0">
              <EvalsRunVisual />
            </div>
          </div>
        </div>
      </section>
      <section className="relative z-[2] px-6 pb-16 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="mb-10 text-center">
            <h2 className="font-display text-[clamp(1.5rem,4vw,2.25rem)] font-bold tracking-[-0.02em] text-text-1">
              Built different from cloud eval platforms
            </h2>
            <p className="mx-auto mt-2.5 max-w-2xl text-[15px] text-text-2">
              Typesafe by default, defined in code, portable across tools, and free to run anywhere
              you deploy.
            </p>
          </div>
          <BentoGrid items={EVALS_HIGHLIGHTS} />
        </div>
      </section>
      <section className="relative z-[2] px-6 pb-24 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="mb-12 text-center">
            <h2 className="font-display text-[clamp(1.5rem,4vw,2.25rem)] font-bold tracking-[-0.02em] text-text-1">
              Name your cases. Score every change.
            </h2>
            <p className="mx-auto mt-2.5 max-w-2xl text-[15px] leading-relaxed text-text-2">
              Hand-rolled evals don&apos;t survive the next model swap or the next engineer. Put
              inputs, scorers, and run configs in TypeScript so every iteration gets a number you
              can compare, and a command you can rerun tomorrow.
            </p>
          </div>
          <EvalsPrimitivesExplorer />
        </div>
      </section>
    </>
  );
}

interface PackagePanelProps {
  active: PackageId;
  onSelectPackage: (pkg: PackageId) => void;
}

export default function PackagePanel({ active, onSelectPackage }: PackagePanelProps) {
  return (
    <div role="tabpanel" id={`panel-${active}`}>
      {active === 'tracing' && <TracingLanding onSelectPackage={onSelectPackage} />}
      {active === 'evals' && <EvalsSection />}
      {active === 'agents' && <AgentsLanding onSelectPackage={onSelectPackage} />}
    </div>
  );
}
