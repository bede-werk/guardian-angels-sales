import React from 'react';
import { formatDate, VISIT_TYPE_LABELS } from '../api';
import { CategoryChip } from './ui/Chip';
import Button from './ui/Button';

// A skipped visit's own detail popup — distinct from VisitDetailModal (built
// for a completed trip's encounters, which a skipped visit never has) and
// UpcomingVisitDetailModal (a still-actionable planned stop, which a skipped
// one no longer is). There's nothing to log, edit, or snooze here — just
// what had been on the calendar before it lapsed: the place, the visit type
// that was planned, and which rep it was planned for. Renders straight off
// the row GET /api/visits/calendar already returned (SkippedVisitsModal's
// `visits` prop) — no refetch, unlike VisitDetailModal's GET /api/visits/:id.
export default function SkippedVisitDetailModal({ visit, onClose }) {
  return (
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{formatDate(visit.scheduled_date)} · Skipped Visit</h2>
          <button className="close" title="Close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body stack">
          {visit.place_name && (
            <div className="tiny">
              <strong>Place:</strong> {visit.place_name}
              {visit.category && <span style={{ marginLeft: 8 }}><CategoryChip category={visit.category} /></span>}
            </div>
          )}
          <div className="tiny"><strong>Type:</strong> {VISIT_TYPE_LABELS[visit.visit_type] || 'Visit'}</div>
          {visit.user_name && (
            <div className="tiny"><strong>Planned for:</strong> {visit.user_name}</div>
          )}
        </div>
        <div className="modal-foot">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
