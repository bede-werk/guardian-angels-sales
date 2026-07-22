import React, { useEffect, useState, useCallback } from 'react';
import { api, formatDate } from '../api';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import DuplicateWarning from './ui/DuplicateWarning';
import useDuplicateMatches from '../hooks/useDuplicateMatches';
import PlacePicker from './ui/PlacePicker';

// Modal to create a new place from a referrer, then assign its notes to it.
// Used when the referrer turns out to be a real place that just isn't in the
// place list yet (rather than an existing place, or a person to dismiss).
function CreatePlaceModal({ referrer, categories, onClose, onCreate }) {
  const [form, setForm] = useState({ name: referrer, category: '', tier: '3', city: 'Lincoln', zip: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // Stable identity so useDuplicateMatches's effect (which now depends on
  // `search`) only re-runs when `form.name` actually changes, not on every
  // unrelated keystroke in this modal's other fields.
  const searchPlaces = useCallback((q) => api.places({ search: q }), []);
  const duplicateMatches = useDuplicateMatches(form.name, searchPlaces);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onCreate(form);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>New place from "{referrer}"</h2>
          <button className="close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}
          <div>
            <label className="field">Name</label>
            <input value={form.name} onChange={set('name')} />
          </div>

          <DuplicateWarning
            matches={duplicateMatches}
            label="Similar place"
            renderMatch={(p) => `${p.name}${p.city ? ` — ${p.city}${p.zip ? ` ${p.zip}` : ''}` : ''}${p.category ? ` · ${p.category}` : ''}`}
          />

          <div className="row">
            <div>
              <label className="field">Category</label>
              <select value={form.category} onChange={set('category')}>
                <option value="">—</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="field">Tier</label>
              <select value={form.tier} onChange={set('tier')}>
                <option value="1">Tier 1</option>
                <option value="2">Tier 2</option>
                <option value="3">Tier 3</option>
              </select>
            </div>
          </div>
          <div className="row">
            <div>
              <label className="field">City</label>
              <input value={form.city} onChange={set('city')} />
            </div>
            <div>
              <label className="field">Zip</label>
              <input value={form.zip} onChange={set('zip')} />
            </div>
          </div>
          <div className="tiny muted">All of this referrer's notes will be attached to the new place.</div>
        </div>
        <div className="modal-foot">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || !form.name.trim()}>
            {saving ? 'Creating…' : 'Create & attach notes'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// "Needs Mapping" screen: referrers from the historical notes import whose
// text couldn't be automatically matched to a place (see
// server/src/scripts/import-notes.js). One card per referrer, with three
// possible actions: assign to an existing place, create a new place from
// it, or dismiss it. Any action applies to ALL of that referrer's pending notes at once.
export default function NeedsMapping({ onChanged }) {
  const [data, setData] = useState(null); // GET /api/notes-review response, grouped by referrer
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(null); // the referrer group currently in the "new place" modal, or null
  const [categories, setCategories] = useState([]); // for the new-place modal's category dropdown
  const [busy, setBusy] = useState(null); // which referrer currently has a request in flight (disables its buttons)

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.notesReview());
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    api.filters().then((f) => setCategories(f.categories)).catch(() => {});
  }, [load]);

  // Reload this screen's data AND tell App.jsx to refresh the tab badge count.
  async function refresh() {
    await load();
    onChanged?.();
  }

  // Assign every pending note from this referrer to an existing place.
  async function assign(group, place) {
    setBusy(group.referrer);
    try {
      await api.assignNote(group.notes[0].id, { placeId: place.id, applyToReferrer: true });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  // Set aside every pending note from this referrer without importing them.
  async function dismiss(group) {
    setBusy(group.referrer);
    try {
      await api.dismissNote(group.notes[0].id, { applyToReferrer: true });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  // Create a brand-new place from this referrer, then assign all its notes to it.
  async function createPlace(group, form) {
    await api.createPlaceFromNote(group.notes[0].id, {
      ...form,
      tier: Number(form.tier),
      applyToReferrer: true,
    });
    await refresh();
  }

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <div className="card-body">
          <div className="tiny">
            <strong>{data.count}</strong> imported notes across <strong>{data.referrer_count}</strong> referrers
            couldn't be matched to a place automatically. Assign each to an existing place, create a new
            place from it, or set it aside. Actions apply to <em>all</em> of a referrer's notes.
          </div>
        </div>
      </div>

      {data.groups.length === 0 ? (
        <div className="card">
          <EmptyState message="Nothing left to map — every note has found its home." />
        </div>
      ) : (
        // One card per referrer, listing every one of their unmatched notes
        // plus the three resolve actions.
        data.groups.map((group) => (
          <div className="card" key={group.referrer}>
            <div className="card-head">
              <h2>{group.referrer}</h2>
              <span className="muted tiny">{group.notes.length} note{group.notes.length === 1 ? '' : 's'}</span>
            </div>
            <div className="card-body">
              <ul className="list" style={{ marginBottom: 12 }}>
                {group.notes.map((n) => (
                  <li key={n.id} className="stack" style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                    <div className="tiny muted">{n.note_date ? formatDate(n.note_date) : 'no date'} · {n.author_name || n.author_raw || '—'}</div>
                    <div className="tiny">{n.note_text}</div>
                  </li>
                ))}
              </ul>
              <div className="row" style={{ alignItems: 'center' }}>
                <PlacePicker onPick={(p) => assign(group, p)} />
                <div style={{ flex: 'unset', display: 'flex', gap: 8 }}>
                  <Button variant="secondary" disabled={busy === group.referrer} onClick={() => setCreating(group)}>
                    New place
                  </Button>
                  <Button variant="ghost" disabled={busy === group.referrer} onClick={() => dismiss(group)}>
                    Set aside
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ))
      )}

      {creating && (
        <CreatePlaceModal
          referrer={creating.referrer}
          categories={categories}
          onClose={() => setCreating(null)}
          onCreate={(form) => createPlace(creating, form)}
        />
      )}
    </div>
  );
}
