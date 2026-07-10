import React from 'react';
import { formatDate } from '../api';
import Button from './ui/Button';

// Read-only popup with everything on file for one referral, plus a way into
// editing it (ReferralModal, opened by the parent via onEdit) — same pattern
// as VisitDetailModal for visits. PersonDetail's referral list rows only show
// date + a notes preview to stay uncluttered; this is where the full note lives.
export default function ReferralDetailModal({ referral, onClose, onEdit, onDelete }) {
  return (
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Referral — {referral.referral_date ? formatDate(referral.referral_date) : 'no date'}</h2>
          <button className="close" title="Close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body stack">
          <div className="tiny"><strong>Notes:</strong> {referral.notes || '—'}</div>
        </div>
        <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
          <Button variant="danger" title="Delete this referral" onClick={() => onDelete?.(referral)}>Delete</Button>
          <div style={{ display: 'flex', gap: 10 }}>
            <Button variant="secondary" onClick={onClose}>Close</Button>
            <Button title="Edit this referral" onClick={() => onEdit?.(referral)}>Edit</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
