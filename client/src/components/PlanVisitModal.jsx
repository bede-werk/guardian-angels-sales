import React, { useEffect, useId, useRef, useState } from 'react';
import { api, today, formatDate, VISIT_TYPE_LABELS, DEFAULT_VISIT_TYPE } from '../api';
import Button from './ui/Button';
import PlacePicker from './ui/PlacePicker';

// Manual Visit Planning (spec §3) - "I'm going to Tabitha on Thursday," said
// directly, no route-planner draft involved. Two entry points, each with one
// side already fixed:
//   - PlaceDetail.jsx's "Plan…" button: the PLACE is fixed (`placeId`/
//     `placeName`), so the form only asks for date/rep/notes.
//   - DayOverflowModal.jsx's "Plan a visit…" button (the calendar day
//     drill-down): the DATE is fixed (`date`), so the form asks for
//     place/rep/notes instead, via PlacePicker.
// Both used to be inline toggle-reveals-a-row-of-inputs forms crammed into
// their host card/popover; pulled into one shared modal since both read as
// too cramped, especially DayOverflowModal's - its popover had to
// recompute its own on-screen position every time the form grew a field.
//
// A 200 response with no visit means the server found a §4.2 warning
// (recently visited nearby, or do_not_visit) and wants confirmation before
// writing anything; the form stays open with that warning shown, and the
// NEXT save resends with force:true. A thrown error (§4.1 hard block, or bad
// input) surfaces as an inline banner - same convention VisitLogModal/
// ReferralModal use, not a window.alert.

// Reduces buildWarnings' §4.2 list (services/manualVisits.js) down to the
// single one worth surfacing - do_not_visit is a deliberate flag someone set
// on the place, which outranks a floor warning's recency guess, same
// "certain fact beats a heuristic" ordering VisitLogModal's primaryConflict
// uses. At most one floor warning ever reaches this array to begin with
// (conflictDetection.js already collapses multiple qualifying visits to
// one), so there's never more than DO_NOT_VISIT plus one floor type to
// choose between.
// DRAFT_ELSEWHERE joined this list on 2026-08-25, when it stopped being a
// hard block (services/manualVisits.js's classifyConflicts). Ranked above
// the two floor types and below DO_NOT_VISIT, matching the relative order
// RoutePlanner.jsx's CONFLICT_PRIORITY already uses: another rep's actual
// draft entry is a definite fact about someone's intent, where a floor
// warning is a recency heuristic - but a do-not-visit flag someone set by
// hand still outranks both.
const WARNING_PRIORITY = ['DO_NOT_VISIT', 'DRAFT_ELSEWHERE', 'FLOOR_COMPLETED', 'FLOOR_PLANNED'];
function primaryWarning(warnings) {
  for (const type of WARNING_PRIORITY) {
    const found = warnings.find((w) => w.type === type);
    if (found) return found;
  }
  return warnings[0];
}

export default function PlanVisitModal({ placeId, placeName, date: fixedDate, userId, users, onClose, onSaved }) {
  // See PlaceModal's identical comment - pairs every label.field below with
  // its input via htmlFor/id.
  const uid = useId();
  const [pickedPlace, setPickedPlace] = useState(null);
  const [date, setDate] = useState(fixedDate || '');
  // Defaults to the same fallback config/visitTypes.js's DEFAULT_VISIT_TYPE
  // uses when nothing else specifies a type, rather than starting blank -
  // matches RoutePlanner.jsx's draft-stop select, which likewise always
  // shows a real type rather than an empty option.
  const [visitType, setVisitType] = useState(DEFAULT_VISIT_TYPE);
  const [assignedUserId, setAssignedUserId] = useState(String(userId));
  const [notes, setNotes] = useState('');
  const [warnings, setWarnings] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const resolvedPlaceId = placeId ?? pickedPlace?.id;
  const resolvedPlaceName = placeName ?? pickedPlace?.name;

  // A §4.1 hard block has no override - unlike a §4.2 warning, there is no
  // "Plan anyway" to press, so the notice has to say what a rep can actually
  // DO or it reads as an unexplained dead end (the block and the warning are
  // styled identically below, deliberately, so the button text is otherwise
  // the only difference between "push past this" and "you are stuck").
  // Points at whichever of place/date this entry point left editable: from
  // PlaceDetail the place is fixed, from DayOverflowModal the date is, and
  // from the Visits tab neither is.
  const blockedAdvice = fixedDate
    ? 'Pick a different place.'
    : placeId
      ? 'Pick a different date.'
      : 'Pick a different date or place.';

  // The message lives at the bottom of the form (right above Save), but on
  // a tall form (DayOverflowModal's place-picker variant, say) that can
  // still be scrolled out of view the moment it appears - a rep shouldn't
  // have to go hunting for why Save just turned into "Plan anyway." Scrolls
  // itself into view any time a fresh error/warning shows up, so it's never
  // a guess.
  const noticeRef = useRef(null);
  useEffect(() => {
    if (error || warnings?.length > 0) {
      // block: 'end' (not 'nearest') - 'nearest' stops as soon as any sliver
      // of the target is on-screen, which can leave most of a multi-line
      // message hidden behind the sticky footer if it was already
      // half-visible. 'end' always scrolls until the target's bottom edge
      // sits at the bottom of the visible area, so the whole message clears
      // the footer every time, not just a peek of it.
      noticeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [error, warnings]);

  async function save() {
    setSaving(true);
    setError(null);
    // Cleared here too, not just on field-change (below) - a "Plan anyway"
    // resend that hits a FRESH problem (someone just took the slot, a
    // permission error) must never leave the earlier warning on screen
    // alongside the new error. Safe to clear before reading `warnings` into
    // `force` just below: setState doesn't mutate this closure's binding
    // mid-call, so that read still sees the pre-clear value either way.
    setWarnings(null);
    try {
      const result = await api.planVisit({
        place_id: resolvedPlaceId,
        scheduled_date: date,
        user_id: assignedUserId || userId,
        visit_type: visitType,
        notes: notes.trim() || null,
        force: warnings ? true : undefined,
      });
      if (result && result.warnings) {
        setWarnings(result.warnings);
        return;
      }
      onSaved?.();
      onClose();
    } catch (e) {
      // A §4.1 hard block (SAME_DATE_VISIT/DRAFT_ELSEWHERE) carries
      // `conflicts` same as a §4.2 warning does - style it the same plain-
      // text way as `warnings` below rather than the generic error-banner,
      // so a rep sees one consistent "collision" look regardless of which
      // side of the block/warn split it landed on. A genuine error (bad
      // input, network failure) has no `conflicts` and keeps the banner.
      setError({ message: e.message, conflict: !!e.conflicts });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      // Stops the mousedown here too, not just the click above - DayOverflowModal
      // (the calendar day drill-down this modal can open from) closes itself on
      // any document-level mousedown outside its own popover; without this, a
      // click anywhere in this modal would bubble past it and close the popover
      // out from under it.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Plan a Visit{resolvedPlaceName ? ` · ${resolvedPlaceName}` : ''}</h2>
          <button className="close" title="Close without saving" onClick={onClose}>×</button>
        </div>
        <div className="modal-body stack">
          <div>
            <label className="field" htmlFor={`${uid}-place`}>Place</label>
            {placeId ? (
              <div className="tiny"><strong>{placeName}</strong></div>
            ) : pickedPlace ? (
              <div className="tag-list" style={{ alignItems: 'center' }}>
                <span className="tiny" style={{ fontWeight: 600 }}>{pickedPlace.name}</span>
                <Button
                  variant="ghost"
                  size="small"
                  disabled={saving}
                  onClick={() => { setPickedPlace(null); setWarnings(null); setError(null); }}
                >
                  Change
                </Button>
              </div>
            ) : (
              <PlacePicker id={`${uid}-place`} autoFocus onPick={(p) => { setPickedPlace(p); setWarnings(null); setError(null); }} />
            )}
          </div>

          <div>
            <label className="field" htmlFor={`${uid}-date`}>Date</label>
            {fixedDate ? (
              <div className="tiny"><strong>{formatDate(fixedDate)}</strong></div>
            ) : (
              <input
                id={`${uid}-date`}
                type="date"
                value={date}
                min={today()}
                onChange={(e) => { setDate(e.target.value); setWarnings(null); setError(null); }}
                disabled={saving}
                autoFocus={!!placeId}
              />
            )}
          </div>

          <div>
            <label className="field" htmlFor={`${uid}-type`}>Visit type</label>
            <select
              id={`${uid}-type`}
              value={visitType}
              onChange={(e) => setVisitType(e.target.value)}
              disabled={saving}
            >
              {Object.entries(VISIT_TYPE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="field" htmlFor={`${uid}-rep`}>Rep</label>
            <select
              id={`${uid}-rep`}
              value={assignedUserId}
              onChange={(e) => { setAssignedUserId(e.target.value); setWarnings(null); setError(null); }}
              disabled={saving}
              title="Who this visit is for - any rep may plan for any other rep"
            >
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.id === userId ? `${u.name} (me)` : u.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="field" htmlFor={`${uid}-notes`}>Notes</label>
            <textarea
              id={`${uid}-notes`}
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={saving}
              placeholder="Optional - who it's with, what you're hoping to accomplish..."
            />
          </div>

        </div>
        {/* Notice sits IN the footer, left of the button, rather than
            stacked above it behind the divider - same move as
            VisitLogModal's own footer. Also means it's now inside the
            sticky footer itself, so it's on-screen at all times without
            needing the scrollIntoView effect above to do anything; that
            effect stays as a harmless no-op/safety net.

            flex: 1 + minWidth: 0, NOT marginRight: auto (what this used to
            be) - see UpcomingVisitDetailModal's identical notice for the
            full reasoning. Short version: flex-wrap breaks lines on each
            item's UNFLEXED content width, so a notice sized to its own text
            claimed the whole line once the text got long and pushed Save
            onto a line by itself; a flex-basis of 0 makes that hypothetical
            width zero, so it never forces the break and still fills the
            space left of the button. */}
        <div className="modal-foot" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <div ref={noticeRef} style={{ flex: 1, minWidth: 0 }}>
            {error && (
              error.conflict
                ? <div className="tiny" style={{ color: 'var(--mauve)' }}>{error.message} {blockedAdvice}</div>
                : <div className="error-banner">{error.message}</div>
            )}
            {warnings?.length > 0 && (
              <div className="tiny" style={{ color: 'var(--mauve)' }}>
                {primaryWarning(warnings).message}
              </div>
            )}
          </div>
          <Button onClick={save} disabled={saving || !date || !resolvedPlaceId}>
            {saving ? 'Saving…' : warnings ? 'Plan anyway' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}
