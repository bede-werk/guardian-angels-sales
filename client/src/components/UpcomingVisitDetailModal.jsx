import React from 'react';
import { formatDate, VISIT_TYPE_LABELS } from '../api';
import Button from './ui/Button';

// Read-only popup for a still-upcoming (planned) visit — the "Upcoming
// Visits" card's own equivalent of VisitDetailModal, which is for visit
// history (completed) only. `onComplete`, when passed, hands this same
// `visit` up to the parent to open in VisitLogModal with its visit_id
// intact — that PATCHes this exact row to status: 'completed' rather than
// creating a new one, so it moves from planned to completed in place
// instead of leaving a stray planned row behind.
export default function UpcomingVisitDetailModal({ visit, onClose, onComplete }) {
  return (
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Visit — {formatDate(visit.scheduled_date)}</h2>
          <button className="close" title="Close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body stack">
          {visit.place_name && (
            <div className="tiny"><strong>Place:</strong> {visit.place_name}</div>
          )}
          <div className="tiny"><strong>Type:</strong> {VISIT_TYPE_LABELS[visit.visit_type] || 'Visit'}</div>
          {(visit.person_name || visit.person_title || visit.person_email || visit.person_phone) && (
            <div className="tiny">
              <strong>Contact:</strong> {[visit.person_name, visit.person_title].filter(Boolean).join(', ') || '—'}
              {visit.person_email && <div>{visit.person_email}</div>}
              {visit.person_phone && <div>{visit.person_phone}</div>}
            </div>
          )}
          {visit.user_name && (
            <div className="tiny"><strong>Rep:</strong> {visit.user_name}</div>
          )}
          {visit.notes && (
            <div className="tiny"><strong>Notes:</strong> {visit.notes}</div>
          )}
        </div>
        <div className="modal-foot">
          <Button variant="secondary" onClick={onClose}>Close</Button>
          {onComplete && (
            <Button title="Log what happened and mark this visit completed" onClick={() => onComplete(visit)}>
              Log this visit
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
