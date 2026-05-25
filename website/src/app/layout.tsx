import { type Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import localFont from 'next/font/local';
import clsx from 'clsx';

import '@/styles/tailwind.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
});

const lexend = localFont({
  src: '../fonts/lexend.woff2',
  display: 'swap',
  variable: '--font-lexend',
});

export const metadata: Metadata = {
  title: {
    template: '%s — m4trix',
    default: 'm4trix — Type-safe agent infrastructure',
  },
  description:
    'Event-driven agent orchestration, evals, and tracing for TypeScript. @m4trix/core, @m4trix/evals, @m4trix/tracing.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-mode="dark"
      data-pkg="agents"
      className={clsx('h-full', inter.variable, lexend.variable, jetbrainsMono.variable)}
      suppressHydrationWarning
    >
      <body className="flex min-h-full antialiased">{children}</body>
    </html>
  );
}
