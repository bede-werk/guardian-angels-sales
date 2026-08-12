import { useCallback, useEffect, useRef, useState } from 'react';

// Delays a modal's actual unmount just long enough for the CSS shrink/fade-out
// (.modal-backdrop.closing, see styles.css) to play instead of the DOM node
// vanishing instantly. `closing` drives the class; `startClosing(callback)`
// plays the animation then invokes `callback` (usually the parent's onClose)
// once it's done. Matches modal-pop-out's own duration below.
const CLOSE_ANIMATION_MS = 150;

export default function useClosingTransition() {
  const [closing, setClosing] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const startClosing = useCallback((callback) => {
    if (timerRef.current) return; // already closing — ignore repeat clicks
    setClosing(true);
    timerRef.current = setTimeout(callback, CLOSE_ANIMATION_MS);
  }, []);

  return { closing, startClosing };
}
