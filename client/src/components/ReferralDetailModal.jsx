import React from 'react';
import { formatDate } from '../api';
import Button from './ui/Button';
import useClosingTransition from '../hooks/useClosingTransition';

// Read-only popup with everything on file for one referral, plus a way into
// editing it (ReferralModal, opened by the parent via onEdit) - same pattern
// as VisitDetailModal for visits. PersonDetail's referral list rows only show
// date + a notes preview to stay uncluttered; this is where the full picture
// lives: who sent it, where it came from (the place snapshot from the day it
// was logged - referrals.place_id, not the person's place today), the date,
// and the full note.
export default function ReferralDetailModal({ referral, person, onClose, onEdit, onDelete }) {
  const { closing, requestClose } = useClosingTransition(onClose);
  const referrer = [person?.name, person?.title].filter(Boolean).join(' · ');
  return (
    <div className={`modal-backdrop${closing ? " closing" : ""}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Referral · {referral.referral_date ? formatDate(referral.referral_date) : 'No Date'}</h2>
          <button className="close" title="Close" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body stack">
          {referrer && <div className="tiny"><strong>Referred by:</strong> {referrer}</div>}
          <div className="tiny">
            <strong>Came from:</strong> {referral.place_name || 'No place on file at the time'}
          </div>
          <div className="tiny">
            <strong>Class:</strong> {referral.class || <span className="muted">Not recorded</span>}
          </div>
          <div className="tiny"><strong>Notes:</strong> {referral.notes || '-'}</div>
        </div>
        <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
          <Button variant="danger" title="Delete this referral" onClick={() => onDelete?.(referral)}>Delete</Button>
          <div style={{ display: 'flex', gap: 10 }}>
            <Button variant="secondary" title="Edit this referral" onClick={() => onEdit?.(referral)}>Edit</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
