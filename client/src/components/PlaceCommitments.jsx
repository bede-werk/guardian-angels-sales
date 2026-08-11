// Place Commitments panel — one section inside PlaceDetail's Upcoming Visits
// card. See server/src/services/placeCommitments.js's module header for the
// model this displays: a place can carry more than one outstanding dated
// promise, the one that binds is whichever comes due FIRST, and nothing
// resolves one except a human (fulfilling it via a visit, rescheduling it,
// or waiving it) — a date passing on its own does nothing.
//
// Same "state/handlers live in the parent, this file is presentational"
// convention as RelationshipDetail.jsx's PlaceRelationship and
// CapacityDetail.jsx's PlaceCapacity: onAdd/onReschedule/onWaive do the
// actual API call + reload in PlaceDetail.jsx and report back true/false, so
// this component only closes its own inline editor on success — a failed
// save leaves the draft in place instead of silently discarding it.
import React, { useState } from 'react';
import { formatDate, today } from '../api';
import Button from './ui/Button';

const DISCHARGE_LABELS = { fulfilled: 'fulfilled', superseded: 'rescheduled', waived: 'waived' };

export function PlaceCommitments({ commitments, people, onAdd, saving, onReschedule, rescheduling, onWaive, waivingId }) {
  const [adding, setAdding] = useState(false);
  const [addDate, setAddDate] = useState('');
  const [addPersonId, setAddPersonId] = useState('');
  const [addNote, setAddNote] = useState('');

  // Only one row's inline editor (reschedule OR waive) is ever open at a
  // time — same single-editor-at-a-time convention CapacityDetail's override
  // vs. observation editors use.
  const [reschedulingId, setReschedulingId] = useState(null);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [reschedulePersonId, setReschedulePersonId] = useState('');
  const [rescheduleNote, setRescheduleNote] = useState('');

  const [waivingDraftId, setWaivingDraftId] = useState(null);
  const [waiveNote, setWaiveNote] = useState('');

  const [showHistory, setShowHistory] = useState(false);

  const outstanding = commitments?.outstanding || [];
  const discharged = commitments?.discharged || [];

  async function commitAdd() {
    const ok = await onAdd(addDate, addPersonId || null, addNote || null);
    if (ok !== false) {
      setAdding(false);
      setAddDate('');
      setAddPersonId('');
      setAddNote('');
    }
  }

  // person_id/note carry forward from the original into the reschedule
  // draft (spec: "both editable") — the date field starts blank since a
  // reschedule always needs a genuinely new date, not the one just missed.
  function startReschedule(c) {
    setWaivingDraftId(null);
    setReschedulingId(c.id);
    setRescheduleDate('');
    setReschedulePersonId(c.person_id || '');
    setRescheduleNote(c.note || '');
  }

  async function commitReschedule(id) {
    const ok = await onReschedule(id, rescheduleDate, reschedulePersonId || null, rescheduleNote || null);
    if (ok !== false) setReschedulingId(null);
  }

  function startWaive(c) {
    setReschedulingId(null);
    setWaivingDraftId(c.id);
    setWaiveNote('');
  }

  async function commitWaive(id) {
    const ok = await onWaive(id, waiveNote || null);
    if (ok !== false) {
      setWaivingDraftId(null);
      setWaiveNote('');
    }
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="tag-list" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="tiny" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.02em' }}>
          Commitments{outstanding.length > 0 ? ` (${outstanding.length})` : ''}
        </div>
        {!adding && (
          <Button variant="secondary" size="small" title="Promise a specific date to return to this place" onClick={() => setAdding(true)}>
            Add…
          </Button>
        )}
      </div>

      {adding && (
        <div className="tag-list" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="date" value={addDate} onChange={(e) => setAddDate(e.target.value)} disabled={saving} autoFocus />
          <select value={addPersonId} onChange={(e) => setAddPersonId(e.target.value)} disabled={saving} style={{ width: 140 }}>
            <option value="">No specific person</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input
            type="text"
            placeholder="Note (optional)"
            value={addNote}
            onChange={(e) => setAddNote(e.target.value)}
            disabled={saving}
            style={{ flex: 1, minWidth: 120 }}
          />
          <Button size="small" onClick={commitAdd} disabled={saving || !addDate}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="secondary" size="small" onClick={() => setAdding(false)} disabled={saving}>
            Cancel
          </Button>
        </div>
      )}

      {outstanding.length === 0 && !adding && <div className="tiny muted">No outstanding commitments.</div>}

      {outstanding.length > 0 && (
        <ul className="list">
          {outstanding.map((c) => (
            <li key={c.id} style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
              {reschedulingId === c.id ? (
                <div className="tag-list" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  <input type="date" value={rescheduleDate} onChange={(e) => setRescheduleDate(e.target.value)} disabled={rescheduling} autoFocus />
                  <select value={reschedulePersonId} onChange={(e) => setReschedulePersonId(e.target.value)} disabled={rescheduling} style={{ width: 140 }}>
                    <option value="">No specific person</option>
                    {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <input
                    type="text"
                    placeholder="Note (optional)"
                    value={rescheduleNote}
                    onChange={(e) => setRescheduleNote(e.target.value)}
                    disabled={rescheduling}
                    style={{ flex: 1, minWidth: 120 }}
                  />
                  <Button size="small" onClick={() => commitReschedule(c.id)} disabled={rescheduling || !rescheduleDate}>
                    {rescheduling ? 'Saving…' : 'Save'}
                  </Button>
                  <Button variant="secondary" size="small" onClick={() => setReschedulingId(null)} disabled={rescheduling}>
                    Cancel
                  </Button>
                </div>
              ) : waivingDraftId === c.id ? (
                <div className="tag-list" style={{ alignItems: 'center' }}>
                  <input
                    type="text"
                    placeholder="Reason (optional)"
                    value={waiveNote}
                    onChange={(e) => setWaiveNote(e.target.value)}
                    disabled={waivingId === c.id}
                    style={{ flex: 1, minWidth: 120 }}
                    autoFocus
                  />
                  <Button variant="danger" size="small" onClick={() => commitWaive(c.id)} disabled={waivingId === c.id}>
                    {waivingId === c.id ? 'Waiving…' : 'Confirm waive'}
                  </Button>
                  <Button variant="secondary" size="small" onClick={() => setWaivingDraftId(null)} disabled={waivingId === c.id}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="tag-list" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <div className="tiny">
                    <strong>{formatDate(c.promised_date)}</strong>
                    {c.promised_date < today() && <span style={{ color: 'var(--mauve)' }}> · overdue</span>}
                    {c.person_name && <span className="muted"> · promised to {c.person_name}</span>}
                    {c.note && <span className="muted"> · {c.note}</span>}
                  </div>
                  <div className="tag-list" style={{ flex: 'unset' }}>
                    <Button variant="secondary" size="small" title="Promise a new date instead" onClick={() => startReschedule(c)}>
                      Reschedule
                    </Button>
                    <Button variant="secondary" size="small" title="Call this off — the place falls back to normal cadence" onClick={() => startWaive(c)}>
                      Waive
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {discharged.length > 0 && (
        <>
          <Button variant="ghost" size="small" style={{ alignSelf: 'flex-start' }} onClick={() => setShowHistory((s) => !s)}>
            {showHistory ? 'Hide history' : `History (${discharged.length})`}
          </Button>
          {showHistory && (
            <ul className="list">
              {discharged.map((c) => (
                <li key={c.id} className="tiny muted" style={{ padding: '4px 0', borderTop: '1px solid var(--border)' }}>
                  {formatDate(c.promised_date)} — {DISCHARGE_LABELS[c.discharge_reason] || c.discharge_reason}
                  {c.person_name ? ` · ${c.person_name}` : ''}
                  {c.note ? ` · ${c.note}` : ''}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
