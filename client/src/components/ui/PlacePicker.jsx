import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api';

// Searchable place picker: type a few characters, pick a matching place from
// the dropdown, calls onPick(place). Lightweight custom autocomplete (no
// library) — `open` controls whether the results dropdown is visible.
// Originally lived only in NeedsMapping.jsx (assigning a note to a place);
// extracted here once PlanVisits.jsx needed the identical picker for adding
// an ad-hoc stop to a draft day.
export default function PlacePicker({ onPick, placeholder = 'Assign to existing place…' }) {
  const [q, setQ] = useState(''); // what's typed in the search box
  const [results, setResults] = useState([]); // matching places from the API
  const [open, setOpen] = useState(false); // whether the results dropdown is showing
  const [error, setError] = useState(null);
  const boxRef = useRef(null); // used to detect clicks outside this component
  // Bumped on every search; a response only gets applied if it's still the
  // most recent request when it resolves — guards against a slower earlier
  // keystroke's response overwriting a faster later one (see People.jsx).
  const requestIdRef = useRef(0);

  // Debounced search: wait 200ms after typing stops before hitting the API.
  useEffect(() => {
    if (!q.trim()) { setResults([]); setError(null); return; }
    const t = setTimeout(async () => {
      const requestId = ++requestIdRef.current;
      try {
        const rows = await api.places({ search: q });
        if (requestIdRef.current !== requestId) return;
        setResults(rows.slice(0, 8)); // cap the dropdown to 8 results
        setOpen(true);
        setError(null);
      } catch (e) {
        if (requestIdRef.current !== requestId) return;
        setError(e.message);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  // Close the dropdown if the user clicks anywhere outside this component.
  useEffect(() => {
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div className="picker" ref={boxRef}>
      <input
        placeholder={placeholder}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
      />
      {error && <div className="tiny" style={{ color: 'var(--danger)' }}>{error}</div>}
      {open && results.length > 0 && (
        <div className="picker-menu">
          {results.map((p) => (
            <button key={p.id} className="picker-item" onClick={() => { onPick(p); setQ(''); setOpen(false); }}>
              <strong>{p.name}</strong>
              <span className="muted tiny"> · {p.category} · {p.city} {p.zip}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
