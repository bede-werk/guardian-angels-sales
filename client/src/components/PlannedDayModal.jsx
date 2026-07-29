import React, { useEffect, useState } from 'react';
import { api, formatDate, VISIT_TYPE_LABELS } from '../api';
import { CategoryChip } from './ui/Chip';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';

// "Already Planned" day drill-down — clicking a committed date's row (see
// RoutePlanner.jsx) opens this instead of exposing Edit/Delete directly on the
// row, matching how Places.jsx/People.jsx keep a list row plain and put the
// actual actions inside the detail modal it opens. Each visit's name is
// itself clickable to open full PlaceDetail (via onViewPlace), same pattern
// as a DraftDay's proposed stops.
//
// Also reused read-only for another rep's planned route (VisitsCalendar.jsx,
// "All reps" scope) — pass `visits` directly (already-loaded calendar rows,
// skipping this component's own fetch), `readOnly` to drop the whole-day
// Edit/Delete footer down to a bare Close, and `title` to swap the header
// from "Planned Route" to e.g. "Nikki Shasserre's Planned Route". Someone
// else's route can never be reopened/deleted from here — only the owning
// rep's own committed-day endpoints support that (see scheduleDrafts.js).
export default function PlannedDayModal({ date, onClose, onViewPlace, onEditDay, editingDay, onDeleteDay, deletingDay, visits: providedVisits, title, readOnly }) {
  const [visits, setVisits] = useState(providedVisits ?? null);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    if (providedVisits) return;
    let cancelled = false;
    api.scheduleDrafts.committedDayVisits(date)
      .then((rows) => { if (!cancelled) setVisits(rows); })
      .catch((e) => { if (!cancelled) setLoadError(e.message); });
    return () => { cancelled = true; };
  }, [date, providedVisits]);

  return (
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{formatDate(date)} · {title || 'Planned Route'}</h2>
          <button className="close" title="Close" onClick={onClose}>×</button>
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
                <li key={v.visit_id ?? v.id} className="stop">
                  <div
                    className={`main${v.place_id ? ' hover-row' : ''}`}
                    title={v.place_id ? 'View place details' : undefined}
                    onClick={v.place_id ? () => onViewPlace(v.place_id) : undefined}
                  >
                    <div className="tag-list" style={{ alignItems: 'center' }}>
                      <div className="name">{v.place_name}</div>
                      {v.category && <CategoryChip category={v.category} />}
                    </div>
                    {v.address && (
                      <div className="meta">{v.address}, {v.city} {v.zip}</div>
                    )}
                  </div>
                  <div className="tiny muted" style={{ whiteSpace: 'nowrap' }}>
                    {VISIT_TYPE_LABELS[v.visit_type] || 'Visit'}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        {readOnly ? (
          <div className="modal-foot">
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        ) : (
          <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
            <Button variant="danger" onClick={onDeleteDay} disabled={deletingDay} title="Remove this day's planned visits">
              {deletingDay ? 'Removing…' : 'Delete'}
            </Button>
            <div style={{ display: 'flex', gap: 10 }}>
              <Button variant="secondary" onClick={onClose}>Close</Button>
              <Button
                onClick={onEditDay}
                disabled={editingDay}
                title="Pull this day's visits back into an editable proposal"
              >
                {editingDay ? 'Editing…' : 'Edit'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
