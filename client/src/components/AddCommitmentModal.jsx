import React, { useState } from 'react';
import { today } from '../api';
import Button from './ui/Button';
import useClosingTransition from '../hooks/useClosingTransition';

// Place Commitments' own create flow - "I'm promising to come back on this
// date," pulled out of PlaceCommitments.jsx's old inline toggle-reveals-a-row
// form into a modal, same move PlanVisitModal already made for Manual Visit
// Planning's inline form. onAdd does the actual api.addCommitment call +
// reload in PlaceDetail.jsx and reports back true/false, so this only closes
// itself on success - a failed save leaves the draft in place.
export default function AddCommitmentModal({ people, onAdd, saving, onClose }) {
  const { closing, requestClose } = useClosingTransition(onClose);
  const [date, setDate] = useState('');
  const [personId, setPersonId] = useState('');
  const [note, setNote] = useState('');

  async function save() {
    const ok = await onAdd(date, personId || null, note || null);
    if (ok !== false) requestClose();
  }

  return (
    <div className={`modal-backdrop${closing ? ' closing' : ''}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Add a Commitment</h2>
          <button className="close" title="Close without saving" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body stack">
          <div>
            <label className="field">Date</label>
            <input type="date" value={date} min={today()} onChange={(e) => setDate(e.target.value)} disabled={saving} autoFocus />
          </div>
          <div>
            <label className="field">Promised to</label>
            <select value={personId} onChange={(e) => setPersonId(e.target.value)} disabled={saving}>
              <option value="">No specific person</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="field">Note</label>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} disabled={saving} placeholder="Optional" />
          </div>
        </div>
        <div className="modal-foot">
          <Button variant="secondary" title="Close without saving" onClick={requestClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || !date}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
    </div>
  );
}
