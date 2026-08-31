import { useCallback, useEffect, useRef, useState } from 'react';

// Delays a modal's actual unmount just long enough for the CSS shrink/fade-out
// (.modal-backdrop.closing, see styles.css) to play instead of the DOM node
// vanishing instantly. `closing` drives the class; `startClosing(callback)`
// plays the animation then invokes `callback` (usually the parent's onClose)
// once it's done. Matches modal-pop-out's own duration below.
const CLOSE_ANIMATION_MS = 150;

// Every currently-open modal that wants Escape-to-close registers its own
// requestClose here, most-recently-opened last. Escape only ever acts on the
// TOP of the stack - without this, a modal opened on top of another (e.g.
// PersonDetail opened from a row inside PlaceDetail) would have both close
// at once on a single Escape press, since each has its own independent
// keydown listener.
const escapeStack = [];

// `onEscape` is the callback Escape should trigger - normally the same
// `onClose` a consumer already passes to `startClosing` for its backdrop-
// click/x button. Omit it and this hook behaves exactly as
// before (no Escape handling, no focus management) - nothing here is
// required of a caller that doesn't ask for it.
export default function useClosingTransition(onEscape) {
  const [closing, setClosing] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const startClosing = useCallback((callback) => {
    if (timerRef.current) return; // already closing - ignore repeat clicks
    setClosing(true);
    timerRef.current = setTimeout(callback, CLOSE_ANIMATION_MS);
  }, []);

  // The same close path a backdrop click/x button already uses - exposed so
  // consumers that just want "close on Escape" don't have to redeclare
  // `() => startClosing(onClose)` themselves.
  const requestClose = useCallback(() => {
    if (onEscape) startClosing(onEscape);
  }, [onEscape, startClosing]);

  // Escape-to-close, scoped to whichever modal is actually on top (see
  // escapeStack above). Also a minimal focus trap: on open, move focus into
  // this modal (skipped if something inside it - e.g. an autoFocus input -
  // already grabbed focus, so this never yanks focus away from a field the
  // rep is about to type into) so Tab starts cycling through the modal
  // instead of whatever was behind it; on close, restore focus to whatever
  // was focused right before this modal opened (the trigger button, in the
  // common case), so keyboard/assistive-tech users land back where they
  // were rather than at the top of the page. Reads the DOM directly
  // (document.querySelectorAll('.modal-backdrop')) rather than requiring
  // every one of this hook's consumers to thread a ref onto their own
  // backdrop/modal divs - every one of them already uses those exact two
  // class names (see styles.css), so this is addressable without touching
  // their JSX at all.
  useEffect(() => {
    if (!onEscape) return undefined;

    escapeStack.push(requestClose);

    const previouslyFocused = document.activeElement;
    const backdrops = document.querySelectorAll('.modal-backdrop');
    const ownBackdrop = backdrops[backdrops.length - 1];
    const modal = ownBackdrop?.querySelector('.modal');
    if (modal && !modal.contains(document.activeElement)) {
      if (!modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1');
      modal.focus({ preventScroll: true });
    }

    function handleKeyDown(e) {
      if (e.key !== 'Escape') return;
      if (escapeStack[escapeStack.length - 1] === requestClose) requestClose();
    }
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const i = escapeStack.lastIndexOf(requestClose);
      if (i !== -1) escapeStack.splice(i, 1);
      if (previouslyFocused && document.body.contains(previouslyFocused) && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [onEscape, requestClose]);

  return { closing, startClosing, requestClose };
}
