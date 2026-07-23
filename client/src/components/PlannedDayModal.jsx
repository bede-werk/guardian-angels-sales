import React, { useEffect, useState } from 'react';
import { api, formatDate, VISIT_TYPE_LABELS } from '../api';
import { TierChip, CategoryChip } from './ui/Chip';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';

// "Already Planned" day drill-down — clicking a committed date's row (see
// PlanVisits.jsx) opens this instead of exposing Edit/Delete directly on the
// row, matching how Places.jsx/People.jsx keep a list row plain and put the
// actual actions inside the detail modal it opens. Each visit's name is
// itself clickable to open full PlaceDetail (via onViewPlace), same pattern
// as a DraftDay's proposed stops.
export default function PlannedDayModal({ date, onClose, onViewPlace, onEditDay, editingDay, canEditDay, onDeleteDay, deletingDay }) {
  const [visits, setVisits] = useState(null);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.scheduleDrafts.committedDayVisits(date)
      .then((rows) => { if (!cancelled) setVisits(rows); })
      .catch((e) => { if (!cancelled) setLoadError(e.message); });
    return () => { cancelled = true; };
  }, [date]);

  return (
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{formatDate(date)}</h2>
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
                <li key={v.visit_id} className="stop">
                  <div
                    className={`main${v.place_id ? ' hover-row' : ''}`}
                    title={v.place_id ? 'View place details' : undefined}
                    onClick={v.place_id ? () => onViewPlace(v.place_id) : undefined}
                  >
                    <div className="tag-list" style={{ alignItems: 'center' }}>
                      <div className="name">{v.place_name}</div>
                      {v.category && <CategoryChip category={v.category} />}
                      {v.tier && <TierChip tier={v.tier} />}
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
        <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
          <Button variant="danger" onClick={onDeleteDay} disabled={deletingDay} title="Remove this day's planned visits">
            {deletingDay ? 'Removing…' : 'Delete'}
          </Button>
          <div style={{ display: 'flex', gap: 10 }}>
            <Button variant="secondary" onClick={onClose}>Close</Button>
            <Button
              onClick={onEditDay}
              disabled={!canEditDay || editingDay}
              title={canEditDay ? "Pull this day's visits back into an editable proposal" : 'Set a starting point before editing a planned day'}
            >
              {editingDay ? 'Editing…' : 'Edit'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
