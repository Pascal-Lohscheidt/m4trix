import Link from 'next/link';
import type { ReactNode } from 'react';

type ExampleShellProps = {
  currentPath: '/sse' | '/trpc';
  title: string;
  description: string;
  children: ReactNode;
};

const routes = [
  { href: '/sse', label: 'sse' },
  { href: '/trpc', label: 'trpc' },
] as const;

export function ExampleShell({ currentPath, title, description, children }: ExampleShellProps) {
  return (
    <div className="min-h-screen bg-zinc-100 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4">
          <div>
            <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{description}</p>
          </div>
          <nav className="flex items-center gap-2">
            {routes.map((route) => (
              <Link
                key={route.href}
                href={route.href}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                  route.href === currentPath
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800'
                }`}
              >
                {route.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}
