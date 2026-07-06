import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api';

// Searchable partner picker: type, pick a result, calls onPick(partner).
function PartnerPicker({ onPick }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    const t = setTimeout(async () => {
      const rows = await api.partners({ search: q });
      setResults(rows.slice(0, 8));
      setOpen(true);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div className="picker" ref={boxRef}>
      <input
        placeholder="Assign to existing partner…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
      />
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

// Modal to create a new partner from a referrer, then assign its notes to it.
function CreatePartnerModal({ referrer, categories, onClose, onCreate }) {
  const [form, setForm] = useState({ name: referrer, category: '', tier: '3', city: 'Lincoln', zip: '' });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save() {
    setSaving(true);
    try {
      await onCreate(form);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>New partner from “{referrer}”</h2>
          <button className="close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div>
            <label className="field">Name</label>
            <input value={form.name} onChange={set('name')} />
          </div>
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
          <div className="tiny muted">All of this referrer's notes will be attached to the new partner.</div>
        </div>
        <div className="modal-foot">
          <button className="btn secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn" onClick={save} disabled={saving || !form.name.trim()}>
            {saving ? 'Creating…' : 'Create & attach notes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// "Needs Mapping" screen: referrers whose notes couldn't be auto-matched to a partner.
export default function NeedsMapping({ onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(null); // referrer being turned into a partner
  const [categories, setCategories] = useState([]);
  const [busy, setBusy] = useState(null);

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

  async function refresh() {
    await load();
    onChanged?.();
  }

  async function assign(group, partner) {
    setBusy(group.referrer);
    try {
      await api.assignNote(group.notes[0].id, { partnerId: partner.id, applyToReferrer: true });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

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

  async function createPartner(group, form) {
    await api.createPartnerFromNote(group.notes[0].id, {
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
            couldn't be matched to a partner automatically. Assign each to an existing partner, create a new
            partner from it, or set it aside. Actions apply to <em>all</em> of a referrer's notes.
          </div>
        </div>
      </div>

      {data.groups.length === 0 ? (
        <div className="card"><div className="empty">🎉 Nothing left to map — every note has a home.</div></div>
      ) : (
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
                    <div className="tiny muted">{n.note_date || 'no date'} · {n.author_name || n.author_raw || '—'}</div>
                    <div className="tiny">{n.note_text}</div>
                  </li>
                ))}
              </ul>
              <div className="row" style={{ alignItems: 'center' }}>
                <PartnerPicker onPick={(p) => assign(group, p)} />
                <div style={{ flex: 'unset', display: 'flex', gap: 8 }}>
                  <button className="btn secondary" disabled={busy === group.referrer} onClick={() => setCreating(group)}>
                    New partner
                  </button>
                  <button className="btn ghost" disabled={busy === group.referrer} onClick={() => dismiss(group)}>
                    Set aside
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))
      )}

      {creating && (
        <CreatePartnerModal
          referrer={creating.referrer}
          categories={categories}
          onClose={() => setCreating(null)}
          onCreate={(form) => createPartner(creating, form)}
        />
      )}
    </div>
  );
}
