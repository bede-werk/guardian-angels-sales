// Place Commitments panel - one section inside PlaceDetail's Upcoming Visits
// card. See server/src/services/placeCommitments.js's module header for the
// model this displays: a place can carry more than one outstanding dated
// promise, the one that binds is whichever comes due FIRST, and nothing
// resolves one except a human (fulfilling it via a visit, rescheduling it,
// or waiving it) - a date passing on its own does nothing.
//
// Below the outstanding list is a collapsible "History (N)" section for
// discharged (fulfilled/rescheduled-away/waived) commitments - restored
// here after a brief period without one; a waived commitment's optional
// reason note (services/placeCommitments.js's waiveCommitment merges it into
// the row's own `note` column as "Waived: ...") has nowhere else to ever be
// seen once it leaves the outstanding list above, so waiving stays
// auditable rather than a promise just quietly vanishing. Creating and
// acting on a commitment happen in AddCommitmentModal.jsx /
// CommitmentDetailModal.jsx (mirrors how the Upcoming Visits list below it
// opens PlanVisitModal / UpcomingVisitDetailModal rather than editing
// inline) - history rows here are read-only aside from the cleanup ✕.
import React, { useState } from 'react';
import { formatDate, today } from '../api';
import Button from './ui/Button';

const DISCHARGE_LABELS = { fulfilled: 'fulfilled', superseded: 'rescheduled', waived: 'waived' };

export function PlaceCommitments({ commitments, onAddClick, onSelect, onDelete, deletingId }) {
  const [showHistory, setShowHistory] = useState(false);
  const outstanding = commitments?.outstanding || [];
  const discharged = commitments?.discharged || [];

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="tag-list" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="tiny muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.02em' }}>
          Commitments{outstanding.length > 0 ? ` (${outstanding.length})` : ''}
        </div>
        <Button variant="secondary" size="small" title="Promise a specific date to return to this place" onClick={onAddClick}>
          + Add a commitment
        </Button>
      </div>

      {outstanding.length === 0 && <div className="tiny muted">No outstanding commitments.</div>}

      {outstanding.length > 0 && (
        <ul className="list">
          {outstanding.map((c) => (
            <li
              key={c.id}
              className="hover-row"
              style={{ padding: '10px 0', borderTop: '1px solid var(--border)', cursor: 'pointer' }}
              onClick={() => onSelect(c)}
            >
              <div className="tiny">
                <strong>{formatDate(c.promised_date)}</strong>
                {c.promised_date < today() && <span style={{ color: 'var(--mauve)' }}> · overdue</span>}
                {c.person_name && <span className="muted"> · promised to {c.person_name}</span>}
                {c.note && <span className="muted"> · {c.note}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {discharged.length > 0 && (
        <>
          <Button variant="ghost" size="small" style={{ alignSelf: 'flex-start' }} onClick={() => setShowHistory((s) => !s)}>
            {showHistory ? 'Hide history' : `History (${discharged.length})`}
          </Button>
          {showHistory && (
            <ul className="list">
              {discharged.map((c) => (
                <li
                  key={c.id}
                  className="tag-list"
                  style={{ padding: '4px 0', borderTop: '1px solid var(--border)', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span className="tiny muted">
                    {formatDate(c.promised_date)} - {DISCHARGE_LABELS[c.discharge_reason] || c.discharge_reason}
                    {c.person_name ? ` · ${c.person_name}` : ''}
                    {c.note ? ` · ${c.note}` : ''}
                  </span>
                  <button
                    type="button"
                    className="icon-remove"
                    title="Delete this from history"
                    onClick={() => onDelete(c.id)}
                    disabled={deletingId === c.id}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
