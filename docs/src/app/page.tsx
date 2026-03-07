import { ImageLogoWithText } from '../components/Logo'
import MatrixRain from './(components)/MatrixRain'
import AnimatedHeadline from './(components)/AnimatedHeadline'

const BENTO_ITEMS = [
  {
    title: 'Event-Driven Agents',
    desc: 'Type-safe agents with schema-validated events. No graphs, no global state.',
    code: "AgentFactory.run().listensTo([evt]).logic(...).produce({})",
    span: 'lg:row-span-2',
  },
  {
    title: 'Agent Network',
    desc: 'Wire agents to channels. One agent or a full swarm.',
    code: 'AgentNetwork.setup(({ registerAgent }) => ...)',
    span: '',
  },
  {
    title: 'Typed Events',
    desc: 'Effect Schema validation. Runtime safety, full inference.',
    code: "AgentNetworkEvent.of('request', S.Struct({...}))",
    span: '',
  },
  {
    title: 'SSE Streaming',
    desc: 'Expose networks as HTTP APIs. Built-in Next.js & Express adapters.',
    code: 'NextEndpoint.from(network.expose({...})).handler()',
    span: '',
  },
  {
    title: 'Channels & Sinks',
    desc: 'Named channels with HTTP stream and Kafka sinks.',
    code: "createChannel('client').sink(sink.httpStream())",
    span: '',
  },
  {
    title: 'Batteries Included',
    desc: 'Matrix agents, Pump streaming, React hooks. One package.',
    code: '@m4trix/core  |  @m4trix/stream  |  @m4trix/react  |  @m4trix/ui',
    span: 'sm:col-span-2',
  },
]

export default function Page() {
  return (
    <div className="relative min-h-screen w-full bg-zinc-950 text-zinc-100">
      {/* Matrix digital rain */}
      <MatrixRain opacity={0.06} color="#00ff41" fontSize={14} speed={45} />

      {/* Scanline overlay */}
      <div
        className="pointer-events-none fixed inset-0 z-40 bg-[repeating-linear-gradient(0deg,rgba(0,255,65,0.008)_0px,rgba(0,255,65,0.008)_1px,transparent_1px,transparent_2px)] bg-[size:100%_2px]"
        aria-hidden
      />

      {/* Navigation */}
      <nav className="sticky top-0 z-50 border-b border-zinc-800/80 bg-zinc-950/95 backdrop-blur-xl">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex h-14 items-center justify-between">
            <div className="flex items-center gap-3">
              <ImageLogoWithText
                className="text-[#00ff41] drop-shadow-[0_0_12px_rgba(0,255,65,0.4)]"
                alt="m4trix"
              />
              <span className="inline-flex items-center rounded-md border border-[#00ff41]/40 bg-[#00ff41]/10 px-2 py-0.5 font-mono text-xs font-medium text-[#00ff41] shadow-[0_0_15px_rgba(0,255,65,0.15)]">
                <span className="mr-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-[#00ff41]" />
                Alpha
              </span>
            </div>
            <div className="flex items-center space-x-3">
              <a
                href="https://github.com/Pascal-Lohscheidt/m4trix"
                className="flex items-center rounded-md border border-zinc-700 px-3 py-1.5 font-mono text-xs text-zinc-400 transition hover:border-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-100"
              >
                <svg
                  className="mr-1.5 h-3.5 w-3.5"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                    clipRule="evenodd"
                  />
                </svg>
                GitHub
              </a>
              <a
                href="https://docs.m4trix.dev"
                className="group flex items-center rounded-md border border-[#00ff41]/50 bg-[#00ff41]/10 px-3 py-1.5 font-mono text-xs font-medium text-[#00ff41] shadow-[0_0_15px_rgba(0,255,65,0.15)] transition hover:bg-[#00ff41]/20 hover:shadow-[0_0_25px_rgba(0,255,65,0.25)]"
              >
                <span className="text-[#00ff41]/70">$</span>
                <span className="ml-1.5">read docs</span>
                <span className="ml-1.5 opacity-0 transition group-hover:opacity-100">
                  →
                </span>
              </a>
            </div>
          </div>
        </div>
      </nav>

      {/* ── Hero Section (HTML) ───────────────────────────────── */}
      <section className="relative z-10 overflow-hidden pt-20 pb-24">
        {/* Glow orbs */}
        <div className="absolute -top-40 left-1/4 h-80 w-80 rounded-full bg-[#00ff41]/15 blur-[128px]" />
        <div className="absolute top-1/2 right-1/4 h-64 w-64 rounded-full bg-cyan-500/10 blur-[100px]" />

        <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
          <div className="mx-auto max-w-3xl text-center">
            <AnimatedHeadline />

            <p className="mx-auto mt-6 max-w-2xl text-lg text-zinc-400">
              Event-driven agent orchestration. Type-safe events, channels, sinks.{' '}
              <code className="rounded border border-zinc-700 bg-zinc-800/80 px-1.5 py-0.5 font-mono text-sm text-[#00ff41]">
                @m4trix/core/matrix
              </code>
              . Build, wire, stream.
            </p>

            {/* Install block */}
            <div className="mx-auto mt-8 max-w-md rounded-lg border border-[#00ff41]/20 bg-zinc-900/80 text-left font-mono text-sm shadow-[0_0_30px_rgba(0,255,65,0.05)]">
              <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#00ff41]/60" />
                  <span className="text-zinc-500"># install</span>
                </div>
                <span className="text-xs text-zinc-600">bash</span>
              </div>
              <div className="space-y-1 p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[#00ff41]/80">$</span>
                  <span className="text-zinc-300">
                    pnpm add{' '}
                    <span className="text-[#00ff41]">@m4trix/core</span>
                  </span>
                </div>
                <div className="flex items-center gap-2 pl-4 text-zinc-500">
                  <span className="text-[#00ff41]">✓</span>
                  <span className="text-[#00ff41]/80">Packages: +1</span>
                  <span className="text-zinc-600">Done in 0.4s</span>
                </div>
              </div>
            </div>

            {/* Entry points */}
            <div className="mt-6 flex flex-wrap justify-center gap-2 font-mono text-xs">
              {[
                { pkg: '@m4trix/core/matrix', desc: 'agents & networks' },
                { pkg: '@m4trix/stream', desc: 'pipes' },
                { pkg: '@m4trix/react', desc: 'hooks' },
              ].map((entry) => (
                <span
                  key={entry.pkg}
                  className="rounded border border-zinc-700/80 bg-zinc-900/80 px-2.5 py-1.5"
                >
                  <span className="text-[#00ff41]">{entry.pkg}</span>
                  <span className="ml-2 text-zinc-600">// {entry.desc}</span>
                </span>
              ))}
            </div>

            {/* CTAs */}
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <a
                href="https://docs.m4trix.dev"
                className="group flex items-center rounded-md border border-[#00ff41]/50 bg-[#00ff41]/10 px-6 py-3 font-mono text-sm font-medium text-[#00ff41] shadow-[0_0_25px_rgba(0,255,65,0.2)] transition hover:border-[#00ff41]/70 hover:bg-[#00ff41]/20 hover:shadow-[0_0_40px_rgba(0,255,65,0.3)]"
              >
                <span className="text-[#00ff41]/70">$</span>
                <span className="ml-2">Quick Start</span>
                <span className="ml-2 opacity-0 transition group-hover:opacity-100">
                  →
                </span>
              </a>
              <a
                href="https://github.com/Pascal-Lohscheidt/m4trix/stargazers"
                className="flex items-center rounded-md border border-zinc-600 px-6 py-3 font-mono text-sm text-zinc-400 transition hover:border-amber-500/50 hover:text-amber-400 hover:shadow-[0_0_20px_rgba(245,158,11,0.15)]"
              >
                <svg
                  className="mr-2 h-5 w-5 text-amber-400"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
                Star on GitHub
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── Bento Section ───────────────────────────────────────── */}
      <section className="relative z-10 px-6 pb-24 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="mb-12 text-center">
            <h2 className="font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Everything you need
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-zinc-400">
              Event-driven agents, typed events, channels, and streaming out of the box.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:auto-rows-[minmax(180px,auto)] lg:gap-6">
            {BENTO_ITEMS.map((item) => (
              <div
                key={item.title}
                className={`group rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-6 transition hover:border-[#00ff41]/30 hover:bg-zinc-900/80 hover:shadow-[0_0_30px_rgba(0,255,65,0.08)] ${item.span || ''}`}
              >
                <h3 className="font-mono text-sm font-medium text-[#00ff41]">
                  {item.title}
                </h3>
                <p className="mt-2 text-sm text-zinc-400">{item.desc}</p>
                <code className="mt-3 block rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs text-cyan-400">
                  {item.code}
                </code>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer - IDE status bar */}
      <footer className="relative z-10 border-t border-zinc-800/80 bg-zinc-950">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-2 lg:px-8">
          <div className="flex items-center gap-4 font-mono text-xs text-zinc-600">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#00ff41]" />
              main
            </span>
            <span>MIT</span>
            <span>Pascal Lohscheidt</span>
          </div>
          <div className="flex items-center gap-4 font-mono text-xs text-zinc-600">
            <a
              href="https://github.com/Pascal-Lohscheidt/m4trix"
              className="transition hover:text-[#00ff41]"
            >
              <svg
                className="inline h-3.5 w-3.5"
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                  clipRule="evenodd"
                />
              </svg>
            </a>
            <span>© {new Date().getFullYear()}</span>
            <span>TypeScript</span>
            <span>UTF-8</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
