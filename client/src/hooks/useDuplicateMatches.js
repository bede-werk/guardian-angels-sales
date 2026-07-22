import { useEffect, useState } from 'react';

// Debounced "does this already exist?" search, shared by every place/person
// creation form (PlaceModal, PersonModal, NeedsMapping's CreatePlaceModal) so
// duplicate-checking works the same way everywhere instead of each form
// rolling its own. `search(query)` is the caller's API call (already scoped
// to a name search, e.g. `(q) => api.places({ search: q })`); its resolved
// rows are shown as possible duplicates, capped at 5.
export default function useDuplicateMatches(query, search, { minLength = 3, enabled = true } = {}) {
  const [matches, setMatches] = useState([]);

  useEffect(() => {
    const trimmed = (query || '').trim();
    if (!enabled || trimmed.length < minLength) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const rows = await search(trimmed);
        if (!cancelled) setMatches((rows || []).slice(0, 5));
      } catch {
        if (!cancelled) setMatches([]); // best-effort — never blocks the form
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, enabled, minLength, search]);

  return matches;
}
