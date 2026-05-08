'use client'

import { useEffect, useState } from 'react'

const ARGUMENTS = [
  'typesafe',
  'without global state',
  'without fixed graphs',
  '...no more graphs!',
]

export default function AnimatedHeadline() {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % ARGUMENTS.length)
    }, 2500)
    return () => clearInterval(id)
  }, [])

  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @keyframes headline-fade {
              from { opacity: 0; transform: translateY(6px); }
              to { opacity: 1; transform: translateY(0); }
            }
            .headline-slide { animation: headline-fade 0.5s ease-out forwards; }
          `,
        }}
      />
      <h1 className="font-display text-5xl font-bold tracking-tight text-white sm:text-6xl lg:text-7xl">
        Orchestrate agents{' '}
        <span className="relative inline-block min-w-[200px] align-bottom sm:min-w-[320px]">
          <span
            key={index}
            className="headline-slide absolute top-0 left-0 text-[#00ff41] drop-shadow-[0_0_20px_rgba(0,255,65,0.5)]"
          >
            {ARGUMENTS[index]}
          </span>
          {/* Invisible spacer to prevent layout shift */}
          <span className="invisible">{ARGUMENTS[index]}</span>
        </span>
      </h1>
    </>
  )
}
