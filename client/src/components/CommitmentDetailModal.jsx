import React, { useState } from 'react';
import { formatDate, today } from '../api';
import Button from './ui/Button';
import useClosingTransition from '../hooks/useClosingTransition';

// Read/act popup for one outstanding commitment - PlaceCommitments.jsx's own
// equivalent of UpcomingVisitDetailModal, pulled out of that file's old
// inline per-row Reschedule/Waive editors so a commitment row behaves the
// same way an upcoming-visit row already does: click the row, act in a
// modal. onReschedule/onWaive do the actual api call + reload in
// PlaceDetail.jsx and report back true/false, so this only closes itself on
// success - a failed save leaves whichever panel was open in place.
export default function CommitmentDetailModal({ commitment, people, onReschedule, rescheduling, onWaive, waiving, onClose }) {
  const { closing, requestClose } = useClosingTransition(onClose);
  const [mode, setMode] = useState(null); // null | 'reschedule' | 'waive'
  // Date starts blank - a reschedule always needs a genuinely new date, not
  // the one just missed. person/note carry forward from the original
  // (spec: "both editable").
  const [date, setDate] = useState('');
  const [personId, setPersonId] = useState(commitment.person_id || '');
  const [note, setNote] = useState(commitment.note || '');
  const [waiveNote, setWaiveNote] = useState('');

  // The person this commitment was promised to might no longer be on this
  // place's current roster (detached/unassigned since the promise was
  // made) - the select below is only ever populated from that current
  // roster, so without this the original id would match no <option>, the
  // browser would show the select as blank/"No specific person", and an
  // untouched Save would go on to overwrite person_id with null, silently
  // turning a person-specific promise into a place-level one. Keeping the
  // original id visible (as a disabled option) instead means it stays
  // selected/shown accurately unless someone deliberately changes it.
  const promisedToKnownPerson = commitment.person_id && people.some((p) => p.id === commitment.person_id);

  async function commitReschedule() {
    const ok = await onReschedule(commitment.id, date, personId || null, note || null);
    if (ok !== false) requestClose();
  }

  async function commitWaive() {
    if (!window.confirm(`Call off the promise for ${formatDate(commitment.promised_date)}? This can't be undone.`)) return;
    const ok = await onWaive(commitment.id, waiveNote || null);
    if (ok !== false) requestClose();
  }

  return (
    <div className={`modal-backdrop${closing ? " closing" : ""}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Commitment - {formatDate(commitment.promised_date)}</h2>
          <button className="close" title="Close" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body stack">
          <div className="tiny">
            <strong>Promised date:</strong> {formatDate(commitment.promised_date)}
            {commitment.promised_date < today() && <span style={{ color: 'var(--mauve)' }}> · overdue</span>}
          </div>
          {commitment.person_name && <div className="tiny"><strong>Promised to:</strong> {commitment.person_name}</div>}
          {commitment.note && <div className="tiny"><strong>Note:</strong> {commitment.note}</div>}
        </div>
        {mode === 'reschedule' ? (
          <div className="modal-foot" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ width: '100%' }}>
              <label className="field">New date</label>
              <input type="date" value={date} min={today()} onChange={(e) => setDate(e.target.value)} disabled={rescheduling} autoFocus />
            </div>
            <div style={{ width: '100%' }}>
              <label className="field">Promised to</label>
              <select value={personId} onChange={(e) => setPersonId(e.target.value)} disabled={rescheduling}>
                <option value="">No specific person</option>
                {/* Keeps a since-detached person visible/selected instead of
                    silently reverting to "No specific person" - see
                    promisedToKnownPerson above. Disabled so it can't be
                    re-chosen once cleared; it only exists to represent what's
                    already selected. */}
                {!promisedToKnownPerson && commitment.person_id && (
                  <option value={commitment.person_id} disabled>
                    {commitment.person_name || 'Unknown person'} (no longer at this place)
                  </option>
                )}
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div style={{ width: '100%' }}>
              <label className="field">Note</label>
              <input type="text" value={note} onChange={(e) => setNote(e.target.value)} disabled={rescheduling} />
            </div>
            <Button variant="secondary" size="small" onClick={() => setMode(null)} disabled={rescheduling}>Cancel</Button>
            <Button size="small" onClick={commitReschedule} disabled={rescheduling || !date}>
              {rescheduling ? 'Saving…' : 'Save'}
            </Button>
          </div>
        ) : mode === 'waive' ? (
          <div className="modal-foot" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Reason (optional)"
              value={waiveNote}
              onChange={(e) => setWaiveNote(e.target.value)}
              disabled={waiving}
              style={{ flex: 1, minWidth: 160 }}
              autoFocus
            />
            <Button variant="secondary" size="small" onClick={() => setMode(null)} disabled={waiving}>Cancel</Button>
            <Button variant="danger" size="small" onClick={commitWaive} disabled={waiving}>
              {waiving ? 'Waiving…' : 'Confirm waive'}
            </Button>
          </div>
        ) : (
          <div className="modal-foot">
            <Button variant="secondary" title="Promise a new date instead" onClick={() => setMode('reschedule')}>
              Reschedule
            </Button>
            <Button variant="secondary" title="Call this off - the place falls back to normal cadence" onClick={() => setMode('waive')}>
              Waive
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
