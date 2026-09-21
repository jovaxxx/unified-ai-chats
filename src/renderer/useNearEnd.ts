import { useEffect, type RefObject } from 'react';

/**
 * Calls `onNearEnd` when the element comes into view (a little before it does), so a list can load its next page by
 * itself as the end is reached. It fires again for the next page only once the list has grown (`count` changes).
 */
export function useNearEnd(
  ref: RefObject<Element | null>,
  active: boolean,
  count: number,
  onNearEnd: () => void,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !active || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onNearEnd();
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
    // `count` re-arms the observer after each page; the callback is read fresh each time it is armed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, active, count]);
}
