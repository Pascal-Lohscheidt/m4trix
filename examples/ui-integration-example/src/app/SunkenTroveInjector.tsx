'use client';

import { useEffect } from 'react';
import { AiCursor } from '@m4trix/ui';

const BuildAiInjector = () => {
  useEffect(() => {
    async function createCursors() {
      // Create just one cursor
      const cursor = AiCursor.spawn();

      await new Promise((resolve) => requestAnimationFrame(resolve));

      // Set initial position
      const startX = 100;
      const startY = 100;
      cursor.jumpTo([startX, startY]);

      // Create a path to visit all order links in sequence
      const orderLinkIds = ['#order-link-0', '#order-link-1', '#order-link-2'];

      // Schedule the cursor to move to each order link
      cursor.scheduleMoves([
        [window.innerWidth - 5, 100],
        [window.innerWidth - 5, 400],
        ...orderLinkIds,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 30_000));

      cursor.hide();

      await new Promise((resolve) => setTimeout(resolve, 1000));

      cursor.show();

      await new Promise((resolve) => setTimeout(resolve, 1000));

      cursor.hide();

      await new Promise((resolve) => setTimeout(resolve, 1000));

      cursor.show();
    }

    createCursors();
  }, []);

  return null;
};

export default BuildAiInjector;
