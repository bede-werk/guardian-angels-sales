import React from 'react';
import { formatDate } from '../api';
import { StatusChip, OutcomeChip } from './ui/Chip';
import Button from './ui/Button';

// Read-only popup with everything on file for one visit, plus a way into
// editing it (VisitLogModal, opened by the parent via onEdit). PersonDetail's
// and PlaceDetail's Visit history rows only show date + who/where + notes to
// stay uncluttered (per an earlier request) — this is where the rest of it
// (status, outcome, logged-by rep, full contact snapshot) still lives.
export default function VisitDetailModal({ visit, onClose, onEdit }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Visit — {visit.scheduled_date ? formatDate(visit.scheduled_date) : 'unscheduled'}</h2>
          <button className="close" title="Close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body stack">
          <div className="tag-list">
            <StatusChip status={visit.status} />
            <OutcomeChip outcome={visit.outcome} />
          </div>
          {visit.place_name && (
            <div className="tiny"><strong>Place:</strong> {visit.place_name}</div>
          )}
          {(visit.person_name || visit.person_title || visit.person_email || visit.person_phone) && (
            <div className="tiny">
              <strong>Contact:</strong> {[visit.person_name, visit.person_title].filter(Boolean).join(', ') || '—'}
              {visit.person_email && <div>{visit.person_email}</div>}
              {visit.person_phone && <div>{visit.person_phone}</div>}
            </div>
          )}
          {visit.user_name && (
            <div className="tiny"><strong>Logged by:</strong> {visit.user_name}</div>
          )}
          <div className="tiny"><strong>Notes:</strong> {visit.notes || '—'}</div>
          {visit.next_visit_date && (
            <div className="tiny"><strong>Next visit:</strong> {formatDate(visit.next_visit_date)}</div>
          )}
        </div>
        <div className="modal-foot">
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button title="Edit this visit's details" onClick={() => onEdit?.(visit)}>Edit</Button>
        </div>
      </div>
    </div>
  );
}
