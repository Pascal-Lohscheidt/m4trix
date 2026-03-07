import Link from 'next/link';

const examples = [
  {
    href: '/sse',
    title: 'SSE Example',
    description: 'Streaming chat over a plain SSE endpoint.',
  },
  {
    href: '/trpc',
    title: 'tRPC Example (coming soon)',
    description: 'Placeholder route for the upcoming tRPC transport variant.',
  },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-semibold text-zinc-900 dark:text-zinc-100">Core Examples</h1>
        <p className="mt-3 text-zinc-600 dark:text-zinc-400">
          Pick a transport-specific subexample. UI components are shared so each route can plug in a
          different agent/network implementation.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {examples.map((example) => (
            <Link
              key={example.href}
              href={example.href}
              className="rounded-2xl border border-zinc-200 bg-white p-5 transition hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
            >
              <h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">{example.title}</h2>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{example.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
