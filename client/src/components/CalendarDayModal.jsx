import React from 'react';
import { formatDate } from '../api';
import { CategoryChip, TierChip, OutcomeChip } from './ui/Chip';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';

// Small status pill for the right side of a row. OutcomeChip already covers
// "completed with a logged outcome" (the common case); a completed visit
// can in principle have no outcome yet (a scheduling stop marked done
// without filling that in), so that gets its own plain badge rather than
// silently falling into "Planned" or "Skipped", neither of which would be
// true. Colors mirror the day-dot legend in styles.css (planned → blue,
// completed → teal, skipped → grey) so the two indicators read as one system.
function statusBadge(v) {
  if (v.status === 'completed') {
    return v.outcome
      ? <OutcomeChip outcome={v.outcome} />
      : <span className="badge" style={{ background: 'var(--teal-tint-2)', color: 'var(--teal-dark)' }}>Completed</span>;
  }
  if (v.status === 'skipped') {
    return <span className="badge" style={{ background: 'var(--grey-tint-1)', color: 'var(--grey-dark)' }}>Skipped</span>;
  }
  return <span className="badge" style={{ background: 'var(--blue-tint-1)', color: 'var(--blue)' }}>Planned</span>;
}

// Day drill-down for the Calendar tab. Unlike PlannedDayModal (which fetches
// its own day's stops), the caller already has every visit for this date
// sitting in its byDate map — this just renders whatever slice it's handed,
// no fetch of its own.
//
// Row click target follows each status's own existing precedent rather than
// inventing a third: a "planned" row opens the full place (PlaceDetail, same
// as PlannedDayModal's rows) — only when it actually has a place to open — a
// "completed"/"skipped" row opens VisitDetailModal (same as PlaceDetail's/
// PersonDetail's own Visit history rows). Hover-row styling is only applied
// where the row genuinely does something on click, same guard PlannedDayModal
// itself uses for its onViewPlace rows.
export default function CalendarDayModal({ date, visits, title, showRepName, onClose, onViewPlace, onLogVisit, onViewVisit }) {
  return (
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{formatDate(date)} · {title}</h2>
          <button className="close" title="Close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {visits.length === 0 ? (
            <EmptyState message="Nothing on the calendar for this day." />
          ) : (
            <ul className="list">
              {visits.map((v) => {
                const isPlanned = v.status === 'planned';
                const clickable = isPlanned ? Boolean(v.place_id) : true;
                const handleRowClick = () => {
                  if (isPlanned) {
                    if (v.place_id) onViewPlace(v.place_id);
                  } else {
                    onViewVisit(v);
                  }
                };
                return (
                  <li
                    key={v.id}
                    className={`stack${clickable ? ' hover-row' : ''}`}
                    style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}
                    onClick={clickable ? handleRowClick : undefined}
                  >
                    <div className="tag-list" style={{ justifyContent: 'space-between' }}>
                      <div className="tag-list" style={{ flex: 'unset' }}>
                        <span style={{ fontFamily: 'var(--font-serif)', fontWeight: 600, fontSize: 15 }}>
                          {v.place_name || 'Unknown place'}
                        </span>
                        {v.category && <CategoryChip category={v.category} />}
                        {v.tier && <TierChip tier={v.tier} />}
                      </div>
                      <div className="tag-list" style={{ flex: 'unset' }}>
                        {statusBadge(v)}
                        {isPlanned && (
                          <Button
                            variant="secondary"
                            size="small"
                            title="Log this visit"
                            onClick={(e) => { e.stopPropagation(); onLogVisit(v); }}
                          >
                            Log visit
                          </Button>
                        )}
                      </div>
                    </div>
                    {showRepName && (
                      <div className="tiny muted">with {v.rep_name || 'Unknown rep'}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="modal-foot">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
