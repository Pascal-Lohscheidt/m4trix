'use client';

import { useEffect, useState } from 'react';

export type DataMode = 'dark' | 'light';

function readDataMode(): DataMode {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-mode') === 'light' ? 'light' : 'dark';
}

export function useDataMode(): DataMode {
  const [mode, setMode] = useState<DataMode>('dark');

  useEffect(() => {
    setMode(readDataMode());

    const observer = new MutationObserver(() => {
      setMode(readDataMode());
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-mode'],
    });

    return () => observer.disconnect();
  }, []);

  return mode;
}
