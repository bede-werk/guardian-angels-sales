import React from 'react';
import { formatDate, VISIT_TYPE_LABELS } from '../api';
import Button from './ui/Button';
import useClosingTransition from '../hooks/useClosingTransition';

// A detail popup for a visit that's TERMINAL but not completed - originally
// written as SkippedVisitDetailModal (skipped only); renamed and generalized
// once the Visits tab needed to open a 'snoozed' row too, which had no
// viewer anywhere in the app before this. Distinct from VisitDetailModal
// (built for a completed trip's encounters, which neither status here ever
// has) and UpcomingVisitDetailModal (a still-actionable planned stop, which
// neither of these is anymore - the date's passed, or the rep deliberately
// deferred it).
//
// 'skipped' is a PASSIVE lapse - stamped automatically by
// services/visitLifecycle.js's sweep once a planned date passes unlogged.
// 'snoozed' is a DELIBERATE rep deferral (POST /visits/:id/snooze), which
// also sets the PLACE's own snooze_until - so a snoozed visit suppresses
// that whole place from route-planner generation for the snooze window, not
// just this one row.
//
// Neither status is proof the visit didn't actually happen - a skip is only
// an absence of a log, and a snooze can still be fulfilled early - so
// `onComplete`, when passed, hands this same `visit` up to the parent to
// open in VisitLogModal with its visit_id intact for EITHER status.
// VisitLogModal always saves with status: 'completed' regardless of what
// status it started at (see its own save()), so this PATCHes the same row
// rather than leaving a stray one behind - same convention
// UpcomingVisitDetailModal's onComplete already uses for planned visits.
//
// Renders straight off the row its caller already has in hand (e.g.
// SkippedVisitsModal's `visits` prop, or the Visits tab's own list row) - no
// refetch, unlike VisitDetailModal's GET /api/visits/:id.
const STATUS_TITLES = { skipped: 'Skipped Visit', snoozed: 'Snoozed Visit' };

// Delete is skipped-only: a snoozed row is the audit trail for an active
// place.snooze_until suppression (see this file's header comment), so
// letting it be deleted here would leave that suppression with no visible
// record of why the place is off-limits. A skipped row is just a passive
// lapse with no such side effect - safe to clear outright.
export default function ResolvedVisitDetailModal({ visit, onClose, onComplete, onDelete }) {
  const { closing, requestClose } = useClosingTransition(onClose);
  return (
    <div className={`modal-backdrop${closing ? " closing" : ""}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{STATUS_TITLES[visit.status] || 'Visit'} · {formatDate(visit.scheduled_date)}</h2>
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
          {/* Snoozed-only: the date the deferral lifts. Also the moment the
              PLACE's own snooze_until (not just this visit) stops suppressing
              it from generation - see this file's header comment. */}
          {visit.status === 'snoozed' && visit.snoozed_until && (
            <div className="tiny"><strong>Deferred until:</strong> {formatDate(visit.snoozed_until)}</div>
          )}
        </div>
        <div className="modal-foot">
          {onDelete && visit.status === 'skipped' && (
            <Button
              variant="danger"
              style={{ marginRight: 'auto' }}
              title="Delete this skipped visit"
              onClick={() => onDelete(visit)}
            >
              Delete
            </Button>
          )}
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
