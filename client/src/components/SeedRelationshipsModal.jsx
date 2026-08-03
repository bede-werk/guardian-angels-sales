// One-time (but re-runnable) relationship seeding.
//
// WHY THIS EXISTS: on the day computed relationship shipped, no visit carried
// the met-with/outcome data the model scores against, so every place would
// have read 'weak' — including places where a real, valuable relationship
// exists. Weak + high capacity is a 7-day cadence, so the route planner would
// have demanded visits everywhere at once. Seeding encodes what the rep
// already knows so day one is honest.
//
// A seed is NOT a permanent override. It's a converged score value that
// decays on the same clock as real visit weight, so it washes out on its own
// (~3% of original after five months on a 30-day category) with no expiry
// logic and nothing to clean up. A real relationship gets visited and earns
// genuine score as the seed fades; an optimistic seed that's never followed up
// decays to nothing, which is the honest answer. A seed is a claim with an
// expiration date attached; an override is a claim that is silently wrong
// forever.
//
// Re-runnable on purpose: re-seeding a person overwrites their value AND
// resets the decay clock (server-side — see routes/people.js), which is the
// intended way to correct a seed you got wrong.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import Button from './ui/Button';

// Converged SCORE values, not buckets — see services/relationship.js's
// thresholds (strong >= 3.4, medium >= 1.3). 4.0 lands a person's place
// solidly in strong on its own; 2.0 in medium; 0.8 is deliberately below the
// medium threshold, so an acquaintance reads weak-ish rather than promoting a
// place on its own.
const SEED_CHOICES = [
  { value: 4.0, label: 'Champion', hint: 'Knows me, sends business, I could call them' },
  { value: 2.0, label: 'Solid', hint: 'Real working relationship' },
  { value: 0.8, label: 'Acquaintance', hint: "We've met, they'd recognize me" },
];

export default function SeedRelationshipsModal({ onClose, onSaved }) {
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  // person_id -> seed value (or null to clear). Only people the user actually
  // touched land here, so an untouched person is never written at all —
  // "skippable" in the real sense, not "silently defaulted to something."
  const [pending, setPending] = useState({});

  useEffect(() => {
    api.people
      .list({})
      .then(setPeople)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Current value for a row: the pending edit if there is one, else whatever
  // is already saved on the person.
  function currentSeed(person) {
    return Object.prototype.hasOwnProperty.call(pending, person.id) ? pending[person.id] : person.relationship_seed;
  }

  function choose(person, value) {
    setPending((p) => {
      const next = { ...p };
      // Clicking the already-selected choice clears it back to "no read."
      next[person.id] = currentSeed(person) === value ? null : value;
      return next;
    });
  }

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return people;
    return people.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
        (p.place_name || '').toLowerCase().includes(term) ||
        (p.title || '').toLowerCase().includes(term)
    );
  }, [people, search]);

  // Grouped by place so a rep can work down one organization at a time, which
  // is how they actually remember these relationships.
  const grouped = useMemo(() => {
    const byPlace = new Map();
    for (const p of filtered) {
      const key = p.place_name || 'Unassigned';
      if (!byPlace.has(key)) byPlace.set(key, []);
      byPlace.get(key).push(p);
    }
    return [...byPlace.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const changeCount = Object.keys(pending).length;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const entries = Object.entries(pending).map(([person_id, seed]) => ({ person_id: Number(person_id), seed }));
      await api.people.seedRelationships(entries);
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Seed relationships</h2>
          <button className="close" title="Close without saving" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          <div className="tiny muted">
            Rate the relationships you already have, so the app doesn't start from zero. These are starting
            estimates that fade over time — logging real visits is what makes a relationship score real.
            Skip anyone you don't have a read on.
          </div>

          <div>
            <label className="field">Search</label>
            <input placeholder="Name, title, or place…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>

          {loading ? (
            <div className="tiny muted">Loading people…</div>
          ) : grouped.length === 0 ? (
            <div className="tiny muted">No people match that search.</div>
          ) : (
            <div className="stack">
              {grouped.map(([placeName, rows]) => (
                <div key={placeName} className="stack" style={{ gap: 6 }}>
                  <div className="tiny" style={{ fontWeight: 700 }}>{placeName}</div>
                  {rows.map((person) => {
                    const seed = currentSeed(person);
                    return (
                      <div
                        key={person.id}
                        className="tag-list"
                        style={{ alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
                      >
                        <span className="tiny" style={{ flex: 1, minWidth: 140 }}>
                          {person.name}
                          {person.title ? <span className="muted"> — {person.title}</span> : null}
                        </span>
                        <span className="tag-list" style={{ flex: 'unset' }}>
                          {SEED_CHOICES.map((choice) => (
                            <Button
                              key={choice.value}
                              size="small"
                              variant={seed === choice.value ? 'primary' : 'secondary'}
                              title={`${choice.hint}${seed === choice.value ? ' (click again to clear)' : ''}`}
                              onClick={() => choose(person, choice.value)}
                              disabled={saving}
                            >
                              {choice.label}
                            </Button>
                          ))}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <Button variant="secondary" title="Close without saving" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            title={changeCount ? `Save ${changeCount} rating${changeCount === 1 ? '' : 's'}` : 'Rate at least one person first'}
            onClick={save}
            disabled={saving || changeCount === 0}
          >
            {saving ? 'Saving…' : changeCount ? `Save ${changeCount} rating${changeCount === 1 ? '' : 's'}` : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}
