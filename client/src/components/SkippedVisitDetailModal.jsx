import React from 'react';
import { formatDate, VISIT_TYPE_LABELS } from '../api';
import { CategoryChip } from './ui/Chip';
import Button from './ui/Button';
import useClosingTransition from '../hooks/useClosingTransition';

// A skipped visit's own detail popup — distinct from VisitDetailModal (built
// for a completed trip's encounters, which a skipped visit never has) and
// UpcomingVisitDetailModal (a still-actionable planned stop, which a skipped
// one no longer is). Nothing to snooze here — the date's already passed —
// but a skip is only a passive lapse (see visitLifecycle.js's sweep), not
// proof the visit didn't actually happen, so `onComplete`, when passed, hands
// this same `visit` up to the parent to open in VisitLogModal with its
// visit_id intact. VisitLogModal always saves with status: 'completed'
// regardless of what status it started at (see its own save()), so this
// PATCHes the same row from skipped to completed rather than leaving a
// stray skipped row behind a separate new one — same convention
// UpcomingVisitDetailModal's onComplete already uses for planned visits.
// Renders straight off the row GET /api/visits/calendar already returned
// (SkippedVisitsModal's `visits` prop) — no refetch, unlike VisitDetailModal's
// GET /api/visits/:id.
export default function SkippedVisitDetailModal({ visit, onClose, onComplete }) {
  const { closing, startClosing } = useClosingTransition();
  const requestClose = () => startClosing(onClose);
  return (
    <div className={`modal-backdrop${closing ? " closing" : ""}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{formatDate(visit.scheduled_date)} · Skipped Visit</h2>
          <button className="close" title="Close" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body stack">
          {visit.place_name && (
            <div className="tiny">
              <strong>Place:</strong> {visit.place_name}
            </div>
          )}
          <div className="tiny"><strong>Type:</strong> {VISIT_TYPE_LABELS[visit.visit_type] || 'Visit'}</div>
          {visit.user_name && (
            <div className="tiny"><strong>Planned for:</strong> {visit.user_name}</div>
          )}
        </div>
        <div className="modal-foot">
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
