import { ExampleShell } from '@/components/examples/example-shell';

export default function TrpcExamplePage() {
  return (
    <ExampleShell
      currentPath="/trpc"
      title="Core Example: tRPC"
      description="Placeholder route for the upcoming tRPC-powered transport example."
    >
      <main className="grid h-[calc(100vh-72px)] place-items-center bg-zinc-50 px-6 dark:bg-zinc-950">
        <div className="max-w-md rounded-2xl border border-dashed border-zinc-300 bg-white p-6 text-center dark:border-zinc-700 dark:bg-zinc-900">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Coming soon</h2>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            This route is reserved for the tRPC implementation using the same reusable chat UI.
          </p>
        </div>
      </main>
    </ExampleShell>
  );
}
