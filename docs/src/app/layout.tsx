import { type Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import localFont from 'next/font/local'
import clsx from 'clsx'

import '@/styles/tailwind.css'

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
})

// Use local version of Lexend so that we can use OpenType features
const lexend = localFont({
  src: '../fonts/lexend.woff2',
  display: 'swap',
  variable: '--font-lexend',
})

export const metadata: Metadata = {
  title: {
    template: '%s - Docs',
    default: '@m4trix/core - The DX first AI library made with TypeScript.',
  },
  description:
    '@m4trix/core is a powerful TypeScript library for building AI-driven web applications. Use @m4trix/core, @m4trix/stream, @m4trix/react, and @m4trix/ui for modular imports.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      className={clsx('h-full antialiased', inter.variable, lexend.variable, jetbrainsMono.variable)}
      suppressHydrationWarning
    >
      <body className="flex min-h-full bg-zinc-950 text-zinc-100 dark:bg-zinc-950">
        {children}
      </body>
    </html>
  )
}
