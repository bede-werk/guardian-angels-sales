import React from 'react';
import { formatDate } from '../api';
import { CategoryChip, TierChip } from './ui/Chip';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';

// A day's skipped visits — the Calendar tab's small status-dot indicator
// (VisitsCalendar.jsx). Every row here is always `status: 'skipped'` (the
// caller already filtered before handing them over), so unlike the old
// shared CalendarDayModal this split off from, there's no per-row status
// branching to do: every row just opens VisitDetailModal on click.
export default function SkippedVisitsModal({ date, visits, showRepName, onClose, onViewVisit }) {
  return (
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{formatDate(date)} · Skipped Visits</h2>
          <button className="close" title="Close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {visits.length === 0 ? (
            <EmptyState message="Nothing on the calendar for this day." />
          ) : (
            <ul className="list">
              {visits.map((v) => (
                <li
                  key={v.id}
                  className="hover-row"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderTop: '1px solid var(--border)' }}
                  onClick={() => onViewVisit(v)}
                >
                  <div className="stack" style={{ minWidth: 0 }}>
                    <div className="tag-list" style={{ minWidth: 0 }}>
                      <span style={{ fontFamily: 'var(--font-serif)', fontWeight: 600, fontSize: 15 }}>
                        {v.place_name || 'Unknown place'}
                      </span>
                      {v.category && <CategoryChip category={v.category} />}
                      {v.tier && <TierChip tier={v.tier} />}
                    </div>
                    {showRepName && (
                      <div className="tiny muted">with {v.user_name || 'Unknown rep'}</div>
                    )}
                  </div>
                  <span className="badge" style={{ background: 'var(--grey-tint-1)', color: 'var(--grey-dark)', flexShrink: 0 }}>Skipped</span>
                </li>
              ))}
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
