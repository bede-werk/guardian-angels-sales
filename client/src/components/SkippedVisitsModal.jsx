import React from 'react';
import { formatDate, VISIT_TYPE_LABELS } from '../api';
import { CategoryChip } from './ui/Chip';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import useClosingTransition from '../hooks/useClosingTransition';

// A day's skipped visits — the Calendar tab's small status-dot indicator
// (VisitsCalendar.jsx). Every row here is always `status: 'skipped'` (the
// caller already filtered before handing them over), so unlike the old
// shared CalendarDayModal this split off from, there's no per-row status
// branching to do: every row just opens SkippedVisitDetailModal on click —
// its own detail popup, not the completed-trip VisitDetailModal, since a
// skipped visit has no encounters to show. Row layout mirrors
// PlannedDayModal/CompletedVisitsModal's main/actions split — a "View place"
// button is the way into PlaceDetail, separate from the row click (visit).
export default function SkippedVisitsModal({ date, visits, showRepName, onClose, onViewVisit, onViewPlace }) {
  const { closing, startClosing } = useClosingTransition();
  const requestClose = () => startClosing(onClose);
  return (
    <div className={`modal-backdrop${closing ? " closing" : ""}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{formatDate(date)} · Skipped Visits</h2>
          <button className="close" title="Close" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body">
          {visits.length === 0 ? (
            <EmptyState message="Nothing on the calendar for this day." />
          ) : (
            <ul className="list">
              {visits.map((v) => (
                <li key={v.id} className="stop" style={{ alignItems: 'center' }}>
                  <div className="main hover-row" title="View this visit's details" onClick={() => onViewVisit(v)}>
                    <div className="tag-list" style={{ alignItems: 'center' }}>
                      <span style={{ fontFamily: 'var(--font-serif)', fontWeight: 600, fontSize: 15 }}>
                        {v.place_name || 'Unknown place'}
                      </span>
                      {v.category && <CategoryChip category={v.category} />}
                    </div>
                    <div className="tiny muted">
                      {[VISIT_TYPE_LABELS[v.visit_type] || 'Visit', showRepName && `with ${v.user_name || 'Unknown rep'}`]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
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
      </div>
    </div>
  );
}
