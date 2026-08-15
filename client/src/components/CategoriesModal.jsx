import React, { useEffect, useState } from 'react';
import { api } from '../api';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import useClosingTransition from '../hooks/useClosingTransition';

// Add / rename / retire a place category - reachable from both People.jsx
// and Places.jsx's Category filter (category is owned by places, but People
// filters by it too). Each action saves immediately; there's no separate
// Save button, matching the rest of the app's inline-edit conventions
// (PlaceDetail/PersonDetail's notes fields).
export default function CategoriesModal({ onClose, onChanged }) {
  const { closing, startClosing } = useClosingTransition();
  const requestClose = () => startClosing(onClose);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const [savingId, setSavingId] = useState(null); // id currently being renamed/deleted, disables its row's buttons

  const load = () => {
    setLoading(true);
    setError(null);
    return api.categories.list()
      .then(setRows)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  async function addCategory() {
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    setError(null);
    try {
      await api.categories.create(name);
      setNewName('');
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setAdding(false);
    }
  }

  function startEdit(row) {
    setEditingId(row.id);
    setEditingName(row.name);
  }

  async function saveEdit(row) {
    const name = editingName.trim();
    if (!name || name === row.name) { setEditingId(null); return; }
    setSavingId(row.id);
    setError(null);
    try {
      await api.categories.rename(row.id, name);
      setEditingId(null);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingId(null);
    }
  }

  async function removeCategory(row) {
    const warning = row.place_count > 0
      ? ` ${row.place_count} place${row.place_count === 1 ? '' : 's'} currently ${row.place_count === 1 ? 'uses' : 'use'} it - ${row.place_count === 1 ? 'it' : 'they'} will become uncategorized.`
      : '';
    if (!window.confirm(`Delete "${row.name}"?${warning} This can't be undone.`)) return;
    setSavingId(row.id);
    setError(null);
    try {
      await api.categories.remove(row.id);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className={`modal-backdrop${closing ? ' closing' : ''}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Manage Categories</h2>
          <button className="close" title="Close" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              placeholder="New category name…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addCategory(); }}
              style={{ flex: 1 }}
            />
            <Button variant="secondary" size="small" onClick={addCategory} disabled={adding || !newName.trim()} style={{ flexShrink: 0 }}>
              {adding ? 'Adding…' : '+ Add'}
            </Button>
          </div>

          {loading ? (
            <div className="loading">Loading…</div>
          ) : rows.length === 0 ? (
            <EmptyState message="No categories yet." />
          ) : (
            <ul className="list">
              {rows.map((row) => (
                <li
                  key={row.id}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                    padding: '8px 0', borderTop: '1px solid var(--border)',
                  }}
                >
                  {editingId === row.id ? (
                    <>
                      <input
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(row); if (e.key === 'Escape') setEditingId(null); }}
                        autoFocus
                        style={{ flex: 1 }}
                      />
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <Button variant="secondary" size="small" onClick={() => setEditingId(null)} disabled={savingId === row.id}>Cancel</Button>
                        <Button size="small" onClick={() => saveEdit(row)} disabled={savingId === row.id}>
                          {savingId === row.id ? 'Saving…' : 'Save'}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div
                        className="hover-row"
                        title={`Click to rename "${row.name}"`}
                        onClick={() => savingId !== row.id && startEdit(row)}
                        style={{ flex: 1, borderRadius: 'var(--radius-sm)', padding: '2px 6px', margin: '-2px -6px' }}
                      >
                        <strong>{row.name}</strong>
                        <span className="tiny muted"> · {row.place_count} {row.place_count === 1 ? 'place' : 'places'}</span>
                      </div>
                      <Button
                        variant="danger"
                        size="small"
                        title={`Delete "${row.name}"`}
                        onClick={() => removeCategory(row)}
                        disabled={savingId === row.id}
                        style={{ flexShrink: 0 }}
                      >
                        ✕
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
