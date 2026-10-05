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
    template: '%s | m4trix',
    default: 'm4trix tracing: open-source tracing for AI agents',
  },
  description:
    'Open-source tracing for LangGraph and LangChain. Traces stay in your files or your AWS account, with a local viewer and an MCP server for coding agents.',
  icons: {
    icon: '/m4trix_logo_tr.png',
    apple: '/m4trix_logo_tr.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-mode="dark"
      data-pkg="tracing"
      className={clsx('h-full', inter.variable, lexend.variable, jetbrainsMono.variable)}
      suppressHydrationWarning
    >
      <body className="flex min-h-full antialiased">{children}</body>
    </html>
  );
}
