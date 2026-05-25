'use client';

import { useEffect, useState } from 'react';

const ARGUMENTS = ['typesafe', 'without global state', 'without fixed graphs', 'as event streams'];

export default function AnimatedHeadline() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % ARGUMENTS.length);
    }, 2600);
    return () => clearInterval(id);
  }, []);

  return (
    <h1 className="font-display text-[clamp(2.25rem,6vw,4rem)] font-bold tracking-[-0.025em] leading-[1.1] text-text-1">
      Orchestrate agents{' '}
      <span className="relative inline-block min-w-[200px] align-bottom sm:min-w-[320px]">
        <span
          key={index}
          className="headline-slide absolute top-0 left-0 text-(--accent) transition-[color] duration-300"
        >
          {ARGUMENTS[index]}
        </span>
        <span className="invisible">{ARGUMENTS[index]}</span>
      </span>
    </h1>
  );
}
