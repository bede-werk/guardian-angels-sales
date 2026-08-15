import React from 'react';
import { formatDate, VISIT_TYPE_LABELS } from '../api';
import { CategoryChip } from './ui/Chip';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import { encounterLabel, joinNames } from './VisitDetailModal';
import useClosingTransition from '../hooks/useClosingTransition';

// A day's completed visits - the Calendar tab's "Completed Visits" pill
// (VisitsCalendar.jsx). Every row here is always `status: 'completed'` (the
// caller already filtered before handing them over), so unlike the old
// shared CalendarDayModal this split off from, there's no per-row status
// branching to do: every row just opens VisitDetailModal on click (outcome/
// tier aren't shown here - full detail's one click away). A separate "View
// place" button is the way into full PlaceDetail (onViewPlace) - same
// main/actions split as PlannedDayModal, so the row click (visit) and the
// button (place) never fight over the same click. `showContact`, when true,
// folds the rep who logged it and who they met into the same line as the
// visit type ("{rep} · with {who}") - the same phrasing PlaceDetail.jsx's own
// visit-history rows use, built from the trip's `encounters` summary. Both
// are gated by the same flag: in "Mine" scope the rep is redundant (you're
// already looking at your own visits), so neither identifying detail shows.
// No crossRepFloorWarning pill, for the same reason VisitDetailModal drops
// it: every row here already happened, so there's nothing left to act on.
export default function CompletedVisitsModal({ date, visits, showContact, onClose, onViewVisit, onViewPlace }) {
  const { closing, startClosing } = useClosingTransition();
  const requestClose = () => startClosing(onClose);
  return (
    <div className={`modal-backdrop${closing ? " closing" : ""}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{formatDate(date)} · Completed Visits</h2>
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
                      {[
                        VISIT_TYPE_LABELS[v.visit_type] || 'Visit',
                        showContact &&
                          [v.user_name, v.encounters?.length && `with ${joinNames(v.encounters.map(encounterLabel))}`]
                            .filter(Boolean)
                            .join(' '),
                      ]
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
