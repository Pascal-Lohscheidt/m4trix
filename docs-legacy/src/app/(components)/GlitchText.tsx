'use client'

export default function GlitchText({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
        @keyframes glitch-1 {
          0%, 100% { clip-path: inset(40% 0 61% 0); transform: translate(-2px, 2px); }
          20% { clip-path: inset(92% 0 1% 0); transform: translate(1px, -1px); }
          40% { clip-path: inset(43% 0 1% 0); transform: translate(-1px, 3px); }
          60% { clip-path: inset(25% 0 58% 0); transform: translate(3px, 1px); }
          80% { clip-path: inset(54% 0 7% 0); transform: translate(-3px, -2px); }
        }
        @keyframes glitch-2 {
          0%, 100% { clip-path: inset(65% 0 13% 0); transform: translate(2px, -1px); }
          20% { clip-path: inset(15% 0 62% 0); transform: translate(-2px, 2px); }
          40% { clip-path: inset(72% 0 9% 0); transform: translate(1px, -3px); }
          60% { clip-path: inset(5% 0 76% 0); transform: translate(-1px, 1px); }
          80% { clip-path: inset(38% 0 45% 0); transform: translate(3px, 2px); }
        }
        .glitch-text {
          position: relative;
        }
        .glitch-text::before,
        .glitch-text::after {
          content: attr(data-text);
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
        }
        .glitch-text::before {
          color: #00ff41;
          animation: glitch-1 3s infinite linear alternate-reverse;
          opacity: 0.8;
        }
        .glitch-text::after {
          color: #22d3ee;
          animation: glitch-2 2s infinite linear alternate-reverse;
          opacity: 0.8;
        }
      `,
        }}
      />
      <span className={`glitch-text ${className}`} data-text={children}>
        {children}
      </span>
    </>
  )
}
