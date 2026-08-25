import React, { useState } from 'react';
import { today } from '../api';
import Button from './ui/Button';
import useClosingTransition from '../hooks/useClosingTransition';

// Marking a place do-not-visit, and changing an existing mark's until-date.
// Was an inline panel that unfolded inside PlaceDetail's Upcoming Visits card
// (four presets, a date field and two buttons, all competing for the width of
// a slide-in card); pulled into a modal 2026-08-25 - the same move
// AddCommitmentModal and PlanVisitModal already made for their own inline
// forms, and for the same reason.
//
// The old panel's preset buttons SAVED on click. In here they only choose,
// and nothing is written until Save - the ordinary modal contract, and what
// AddCommitmentModal/PlanVisitModal do. That also means the Change flow can
// open pre-filled with whatever the mark says today, which a panel of
// fire-on-click buttons had no way to show.

// Longer-scale than UpcomingVisitDetailModal's own SNOOZE_PRESETS (1/2 weeks,
// 1 month) on purpose: do-not-visit is a deliberate "stop proposing this
// place" call, not a short rotation nudge, so the defaults skew toward the
// kind of horizon that decision actually needs.
const DO_NOT_VISIT_PRESETS = [
  { label: '1 month', days: 30 },
  { label: '3 months', days: 90 },
  { label: '6 months', days: 180 },
];

// A plain date-string add, no month-length edge cases - same "+N days, not a
// calendar month" math UpcomingVisitDetailModal's snooze presets use.
function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// `active`/`until` are the place's CURRENT mark, so re-opening on an already-
// marked place ("Change") starts on what it says rather than blank: a date
// means that date, active-with-no-date means indefinite. onSet does the real
// api.updatePlace + reload up in PlaceDetail.jsx and reports back true/false,
// so this only closes itself on success - a failed save leaves the choice in
// place.
export default function DoNotVisitModal({ placeName, active, until, onSet, saving, onClose }) {
  const { closing, requestClose } = useClosingTransition(onClose);
  // 'date' | 'indefinite' | null. null is "nothing picked yet", which is what
  // keeps Save disabled on a first open - there is no sensible default here,
  // and defaulting to indefinite would be the most consequential possible
  // guess to make on the rep's behalf.
  const [mode, setMode] = useState(active ? (until ? 'date' : 'indefinite') : null);
  const [date, setDate] = useState(active && until ? until : '');

  function pickDate(value) {
    setMode('date');
    setDate(value);
  }

  async function save() {
    const ok = await onSet(mode === 'indefinite' ? null : date);
    if (ok !== false) requestClose();
  }

  const incomplete = mode === null || (mode === 'date' && !date);

  return (
    <div className={`modal-backdrop${closing ? ' closing' : ''}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Do Not Visit{placeName ? ` · ${placeName}` : ''}</h2>
          <button className="close" title="Close without saving" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body stack">
          {/* What the mark actually does, said once. It only ever SKIPS this
              place in future route proposals - the old inline panel's one-line
              caption ("Stop proposing this place in the route planner until…")
              had no room to say what it leaves alone, which is the part a rep
              hesitates over. */}
          <div className="tiny muted">
            The route planner stops proposing this place. Nothing already on file
            changes. You can still log a visit or add this place to a route manually.
          </div>
          <div>
            <label className="field">Until</label>
            {/* Selected preset is the primary variant, the rest secondary -
                the Button system's existing vocabulary, rather than a new
                selected-chip affordance (see UI_SPEC.md). A preset fills the
                date field below it, so the resulting date is always visible
                rather than implied. */}
            <div className="tag-list" style={{ marginBottom: 8 }}>
              {DO_NOT_VISIT_PRESETS.map((p) => {
                const iso = addDaysISO(p.days);
                return (
                  <Button
                    key={p.days}
                    variant={mode === 'date' && date === iso ? 'primary' : 'secondary'}
                    size="small"
                    disabled={saving}
                    onClick={() => pickDate(iso)}
                  >
                    {p.label}
                  </Button>
                );
              })}
              <Button
                variant={mode === 'indefinite' ? 'primary' : 'secondary'}
                size="small"
                disabled={saving}
                title="Never propose this place again until someone lifts the mark by hand"
                onClick={() => { setMode('indefinite'); setDate(''); }}
              >
                Indefinitely
              </Button>
            </div>
            {/* min=today: a mark whose until-date is already past is dead on
                arrival - it lapses the instant it's written (the flag is
                compared live against today, never cleared - see
                services/doNotVisit.js). The old inline field had no min and
                would happily save one. */}
            <input
              type="date"
              value={date}
              min={today()}
              onChange={(e) => pickDate(e.target.value)}
              disabled={saving}
            />
          </div>
        </div>
        <div className="modal-foot">
          <Button variant="danger" onClick={save} disabled={saving || incomplete}>
            {saving ? 'Saving…' : active ? 'Update' : 'Do not visit'}
          </Button>
        </div>
      </div>
    </div>
  );
}
