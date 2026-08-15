import React, { useEffect, useState } from 'react';
import { api, formatDate, crossRepFloorWarningText, VISIT_TYPE_LABELS } from '../api';
import { CategoryChip } from './ui/Chip';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import VisitLogModal from './VisitLogModal';
import UpcomingVisitDetailModal from './UpcomingVisitDetailModal';
import useClosingTransition from '../hooks/useClosingTransition';

// "Already Planned" day drill-down — clicking a committed date's row (see
// RoutePlanner.jsx) opens this instead of exposing Edit/Delete directly on the
// row, matching how Places.jsx/People.jsx keep a list row plain and put the
// actual actions inside the detail modal it opens. This is a list of
// VISITS first and foremost: clicking a row opens the same read-only
// UpcomingVisitDetailModal PlaceDetail's own "Upcoming visits" card uses,
// whose "Complete Visit" action is what actually opens VisitLogModal (see
// onComplete below) — this is how a planned stop becomes a completed one;
// logging it drops the row out of this list (reloadOwnVisits) and, via
// onChanged, tells VisitsCalendar to reload so the day cell's pills
// (planned -> completed) update too. A separate "View place" button is the
// way into full PlaceDetail (onViewPlace) instead — the inverse of the row
// click, on purpose, since this modal's whole point is showing what's
// planned for the day, not the places themselves.
//
// Also reused read-only for another rep's planned route (VisitsCalendar.jsx,
// "All reps" scope) — pass `visits` directly (already-loaded calendar rows,
// skipping this component's own fetch), `readOnly` to drop the whole-day
// Edit/Delete footer down to a bare Close, and `title` to swap the header
// from "Planned Route" to e.g. "Nikki Shasserre's Planned Route". Someone
// else's route can never be reopened/deleted from here — only the owning
// rep's own committed-day endpoints support that (see scheduleDrafts.js).
export default function PlannedDayModal({ date, onClose, onViewPlace, onEditDay, editingDay, onDeleteDay, deletingDay, visits: providedVisits, title, readOnly, userId, onChanged }) {
  const { closing, startClosing } = useClosingTransition();
  const requestClose = () => startClosing(onClose);
  const [visits, setVisits] = useState(providedVisits ?? null);
  const [loadError, setLoadError] = useState(null);
  const [viewingVisit, setViewingVisit] = useState(null); // planned visit open in UpcomingVisitDetailModal, or null
  const [loggingVisit, setLoggingVisit] = useState(null); // planned visit open in VisitLogModal for completing, or null

  // Discard all visits (scheduleDraft.js's deleteCommittedDay) clears the
  // WHOLE day regardless of source/planned_manually (Bede's call — see that
  // function's own comment), so its footer just needs "is there anything
  // here at all," visits included whether planner-committed or manual.
  //
  // Edit (reopenCommittedDay) is different: it's still scoped server-side to
  // source: 'planner' only, since pulling a manual visit into
  // schedule_draft_stops would misrepresent it as a re-orderable proposal —
  // 404s on a manual-only day. hasPlannerStops gates the Edit button alone
  // for that reason. Defaults to true while still loading, so it doesn't
  // flash present-then-hidden on the common (non-manual-only) day.
  const hasAnyStops = visits == null || visits.length > 0;
  const hasPlannerStops = visits == null || visits.some((v) => v.planned_manually !== 1);

  useEffect(() => {
    if (providedVisits) return;
    let cancelled = false;
    api.scheduleDrafts.committedDayVisits(date)
      .then((rows) => { if (!cancelled) setVisits(rows); })
      .catch((e) => { if (!cancelled) setLoadError(e.message); });
    return () => { cancelled = true; };
  }, [date, providedVisits]);

  // A logged visit is no longer `status: 'planned'`, so it should drop out of
  // this list — same server call the mount effect above uses, just re-run on
  // demand instead of only once. Not applicable to the read-only other-rep
  // case (no reload prop, and the Log button never renders there anyway).
  function reloadOwnVisits() {
    if (providedVisits) return;
    api.scheduleDrafts.committedDayVisits(date)
      .then(setVisits)
      .catch((e) => setLoadError(e.message));
  }

  // Deletes ONE planned visit off this day, as opposed to onDeleteDay's
  // whole-day "Discard all visits". Same confirm+delete+reload shape as
  // PlaceDetail.jsx's own removeVisit; not offered in readOnly mode (see
  // UpcomingVisitDetailModal below), matching onComplete/onSnoozed.
  async function removeVisit(visit) {
    if (!window.confirm("Delete this planned visit? This can't be undone.")) return;
    try {
      await api.deleteVisit(visit.visit_id ?? visit.id);
      setViewingVisit(null);
      reloadOwnVisits();
      onChanged?.();
    } catch (e) {
      window.alert(e.message);
    }
  }

  return (
    <div className={`modal-backdrop${closing ? ' closing' : ''}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{formatDate(date)} · {title || 'Planned Route'}</h2>
          <button className="close" title="Close" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body">
          {loadError ? (
            <div className="error-banner">{loadError}</div>
          ) : visits === null ? (
            <div className="loading">Loading…</div>
          ) : visits.length === 0 ? (
            <EmptyState message="Nothing planned for this day." />
          ) : (
            <ul className="list">
              {visits.map((v) => (
                <li key={v.visit_id ?? v.id} className="stop" style={{ alignItems: 'center' }}>
                  <div
                    className="main hover-row"
                    title="View this visit's details"
                    onClick={() => setViewingVisit(v)}
                  >
                    <div className="tag-list" style={{ alignItems: 'center' }}>
                      <div className="name">{v.place_name}</div>
                      {v.category && <CategoryChip category={v.category} />}
                    </div>
                    <div className="tiny muted">
                      {VISIT_TYPE_LABELS[v.visit_type] || 'Visit'}
                      {/* Manual Visit Planning spec §5/§7.3 — "manually
                          planned" always shown for a manual stop; "Planned
                          by {Name}" only when someone OTHER than the
                          assignee planned it (cross-rep). userId is this
                          modal's OWN viewer, not necessarily v.user_id —
                          "planned it for someone else" reads correctly
                          either way since it compares against the row's own
                          assignee, not the viewer. */}
                      {v.planned_manually === 1 && (
                        <>
                          {' · '}
                          <span style={{ color: 'var(--blue-dark)', fontWeight: 600 }}>Manually planned</span>
                          {v.created_by_user_id != null && v.created_by_user_id !== v.user_id ? ` · planned by ${v.created_by_name || 'another rep'}` : ''}
                        </>
                      )}
                    </div>
                    {v.crossRepFloorWarning && (
                      <div
                        className="tiny"
                        style={{ color: 'var(--mauve)', background: 'var(--mauve-tint-1)', padding: '2px 8px', borderRadius: 'var(--radius-sm)', display: 'inline-block', marginTop: 4, fontWeight: 600 }}
                      >
                        {crossRepFloorWarningText(v.crossRepFloorWarning)}
                      </div>
                    )}
                  </div>
                  <div className="actions" style={{ alignItems: 'center' }}>
                    {v.place_id && (
                      <Button variant="secondary" size="small" title="View this place's details" onClick={() => onViewPlace(v.place_id)}>
                        View place
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        {!readOnly && hasAnyStops && (
          <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
            <Button variant="danger" onClick={onDeleteDay} disabled={deletingDay} title="Remove every visit planned for this day, manually-planned ones included">
              {deletingDay ? 'Removing…' : 'Discard visits'}
            </Button>
            {hasPlannerStops && (
              <div style={{ display: 'flex', gap: 10 }}>
                <Button
                  variant="secondary"
                  onClick={onEditDay}
                  disabled={editingDay}
                  title="Pull this day's visits back into an editable proposal"
                >
                  {editingDay ? 'Editing…' : 'Edit'}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {viewingVisit && (
        <UpcomingVisitDetailModal
          visit={viewingVisit}
          onClose={() => setViewingVisit(null)}
          onComplete={readOnly ? undefined : (v) => { setViewingVisit(null); setLoggingVisit(v); }}
          onSnoozed={readOnly ? undefined : () => { setViewingVisit(null); reloadOwnVisits(); onChanged?.(); }}
          onDelete={readOnly ? undefined : removeVisit}
          onEdited={readOnly ? undefined : () => { setViewingVisit(null); reloadOwnVisits(); onChanged?.(); }}
        />
      )}

      {loggingVisit && (
        <VisitLogModal
          visit={loggingVisit}
          userId={userId}
          onClose={() => setLoggingVisit(null)}
          onSaved={() => { reloadOwnVisits(); onChanged?.(); }}
        />
      )}
    </div>
  );
}
