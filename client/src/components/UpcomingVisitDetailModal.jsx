import React, { useEffect, useRef, useState } from 'react';
import { api, today, formatDate, crossRepFloorWarningText, VISIT_TYPE_LABELS, DEFAULT_VISIT_TYPE } from '../api';
import Button from './ui/Button';
import useClosingTransition from '../hooks/useClosingTransition';

// Presets shown on the Snooze panel below. "1 month" is a plain +30 days,
// not a calendar-month jump - keeps the math (and the commitment-guard
// comparison against a place's next_visit_date) a simple date string add,
// no month-length edge cases.
const SNOOZE_PRESETS = [
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '1 month', days: 30 },
];

function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Reduces buildWarnings' §4.2 list (services/manualVisits.js) down to the
// single one worth surfacing - same priority PlanVisitModal.jsx's
// primaryWarning uses (do_not_visit is a deliberate flag, so it outranks a
// floor warning's recency guess); duplicated rather than shared since
// there's no client-side utils module these two pull from yet.
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

// Mirrors the server's own ownership rules exactly - services/manualVisits.js's
// canEditManualVisit/canDeleteManualVisit, and the inline check in
// routes/visits.js's POST /:id/snooze - so a rep never sees an action here
// the server would reject. This matters because this modal isn't always
// opened on the viewer's OWN visit: PlaceDetail's Upcoming Visits card and
// the Visits tab both intentionally list every rep's planned visits (so you
// can see who else has a place covered), not just the viewer's own. Delete
// alone is per-visit permissive to the CREATOR too, matching the server's
// "creator may also delete on someone else's behalf" rule (§5) - Edit and
// Snooze stay assignee-only.
function canEditVisit(visit, userId) {
  return userId != null && visit.user_id === userId;
}
function canDeleteVisit(visit, userId) {
  if (userId == null) return false;
  if (visit.planned_manually) return visit.user_id === userId || visit.created_by_user_id === userId;
  return visit.user_id == null || visit.user_id === userId;
}
function canSnoozeVisit(visit, userId) {
  return userId != null && (visit.user_id == null || visit.user_id === userId);
}

// Read-only popup for a still-upcoming (planned) visit - the "Upcoming
// Visits" card's own equivalent of VisitDetailModal, which is for visit
// history (completed) only. `onComplete`, when passed, hands this same
// `visit` up to the parent to open in VisitLogModal with its visit_id
// intact - that PATCHes this exact row to status: 'completed' rather than
// creating a new one, so it moves from planned to completed in place
// instead of leaving a stray planned row behind.
//
// `onSnoozed`, when passed, is what enables the Snooze button at all (same
// "omit the prop to omit the action" convention onComplete already uses) -
// PlannedDayModal's read-only "someone else's route" mode omits both. Fires
// with the updated (now status: 'snoozed') visit once POST /:id/snooze
// succeeds, so the caller can drop it from whatever "planned" list it came
// from, same as onComplete's caller does after logging.
//
// `onDelete`, same convention again - omitted in PlannedDayModal's
// read-only mode. Like VisitDetailModal's own onDelete, this just hands the
// visit up to the caller's existing removeVisit (confirm + api.deleteVisit +
// reload lives there, not here) rather than duplicating it.
//
// `onEdited`, same convention again - enables the Edit button, which opens a
// date/type/notes panel (mirrors the Snooze panel below) and saves through
// api.editVisit (PATCH /:id/edit). That endpoint works on ANY still-planned
// visit, not just one already planned_manually - the FIRST successful edit
// through it is what promotes a planner-committed visit into a
// manually-planned one (see services/manualVisits.js's editVisit for why),
// so this is the one place in the app that can turn a route-planner stop
// into something a rep now owns and can freely reschedule. Same warn-then-
// force response shape as Snooze/PlanVisitModal: a changed date can come
// back with §4 floor/do-not-visit warnings pending a "Save anyway" confirm.
//
// Passing onDelete/onEdited/onSnoozed only controls whether the ACTION
// exists in this context at all (PlannedDayModal's read-only mode omits all
// three) - it's not the same as the viewer being allowed to use it. A
// caller that lists every rep's visits (PlaceDetail's Upcoming Visits card,
// the Visits tab) can open this on a visit that isn't the viewer's own, so
// canEditVisit/canDeleteVisit/canSnoozeVisit above additionally gate each
// button on `userId`, matching the server's own ownership rules exactly -
// otherwise a rep could fill out a whole Edit form (or confirm a Delete)
// only to be rejected by the server after the fact. `onComplete` is
// deliberately NOT gated this way: logging/covering a teammate's still-open
// stop is an intentional, allowed case (see routes/visits.js's PATCH
// comment), surfaced instead as a confirm() at the caller (PlaceDetail.jsx/
// Visits.jsx), not a hard block.
export default function UpcomingVisitDetailModal({ visit, userId, onClose, onComplete, onSnoozed, onDelete, onEdited }) {
  const { closing, requestClose } = useClosingTransition(onClose);
  const canEdit = canEditVisit(visit, userId);
  const canDelete = canDeleteVisit(visit, userId);
  const canSnooze = canSnoozeVisit(visit, userId);
  const [snoozing, setSnoozing] = useState(false); // showing the preset/date panel, vs the normal footer
  const [customDate, setCustomDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false); // showing the date/type/notes edit panel, vs the normal footer
  const [editDate, setEditDate] = useState(visit.scheduled_date || '');
  // Same "always a real type, never blank" default as PlanVisitModal's own
  // select - an already-typed visit keeps its type, one with none (a bare
  // planner stop, or an old manual visit from before types were captured)
  // starts from the same DEFAULT_VISIT_TYPE fallback.
  const [editVisitType, setEditVisitType] = useState(visit.visit_type || DEFAULT_VISIT_TYPE);
  const [editNotes, setEditNotes] = useState(visit.notes || '');
  const [editWarnings, setEditWarnings] = useState(null);
  const [editError, setEditError] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);

  // Same "never make a rep guess" treatment as PlanVisitModal/VisitLogModal
  // - scrolls the notice into view the moment it appears, in case this panel
  // (or the modal around it) is scrolled such that the bottom isn't already
  // in view.
  const noticeRef = useRef(null);
  useEffect(() => {
    if (editError || editWarnings?.length > 0) {
      // block: 'end', not 'nearest' - see PlanVisitModal's own comment on
      // this same call.
      noticeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [editError, editWarnings]);

  async function doEdit({ force } = {}) {
    setSavingEdit(true);
    setEditError(null);
    // Same reasoning as PlanVisitModal.jsx's save(): a "Save anyway" resend
    // that hits a fresh problem must never leave the earlier warning
    // showing alongside the new error. Safe to clear before `force`
    // (passed in by the caller, not read from state here) is used below.
    setEditWarnings(null);
    try {
      const visitId = visit.visit_id ?? visit.id;
      const result = await api.editVisit(visitId, {
        scheduled_date: editDate,
        visit_type: editVisitType,
        notes: editNotes.trim() || null,
        force,
      });
      if (result && result.warnings) {
        setEditWarnings(result.warnings);
        return;
      }
      setEditing(false);
      onEdited?.(result);
    } catch (e) {
      // Same conflict-vs-generic split as PlanVisitModal's save() - a §4.1
      // hard block (SAME_DATE_VISIT/DRAFT_ELSEWHERE) carries `conflicts` and
      // renders as plain text like editWarnings below; a genuine error
      // (permission, bad date) keeps the banner.
      setEditError({ message: e.message, conflict: !!e.conflicts });
    } finally {
      setSavingEdit(false);
    }
  }

  // Two-step by necessity, not choice: the server can't know a chosen date
  // is fine until it's checked this place's own commitment (see
  // routes/visits.js's POST /:id/snooze) - a client-side guess here would
  // just duplicate that check and could drift from it. SNOOZE_SWALLOWS_
  // COMMITMENT is the only 409 this endpoint returns, so no code check is
  // needed beyond "was there a conflict at all."
  async function doSnooze(snoozedUntil, { force } = {}) {
    if (!snoozedUntil) return;
    setSaving(true);
    try {
      // Same visit_id/id duality VisitLogModal already resolves (see its own
      // `isEditing`/`api.visit(visit.visit_id)`): PlaceDetail's "Upcoming
      // visits" rows carry a real `id`, but PlannedDayModal's rows come from
      // scheduleDraft.js's committedDayVisits, which aliases it to
      // `visit_id` instead. `visit.id` alone is undefined on that path.
      const visitId = visit.visit_id ?? visit.id;
      const updated = await api.snoozeVisit(visitId, { snoozed_until: snoozedUntil, force });
      onSnoozed?.(updated);
    } catch (e) {
      if (!force && e.code === 'SNOOZE_SWALLOWS_COMMITMENT') {
        if (window.confirm(`${e.message} Snooze anyway?`)) {
          await doSnooze(snoozedUntil, { force: true });
          return;
        }
      } else {
        window.alert(e.message);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`modal-backdrop${closing ? " closing" : ""}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Visit · {formatDate(visit.scheduled_date)}</h2>
          <button className="close" title="Close" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body stack">
          {visit.place_name && (
            <div className="tiny"><strong>Place:</strong> {visit.place_name}</div>
          )}
          {!editing && (
            <div className="tiny"><strong>Type:</strong> {VISIT_TYPE_LABELS[visit.visit_type] || 'Visit'}</div>
          )}
          {/* No contact line here on purpose. Who was met lives in a visit's
              `encounters`, which only get written when the visit is logged -
              a planned stop having none is its normal state, not missing
              data. The completed equivalent is VisitDetailModal. */}
          {visit.user_name && (
            <div className="tiny"><strong>Rep:</strong> {visit.user_name}</div>
          )}
          {visit.notes && !editing && (
            <div className="tiny"><strong>Notes:</strong> {visit.notes}</div>
          )}
          {visit.crossRepFloorWarning && (
            <div
              className="tiny"
              // alignSelf: this modal's body is a .stack (display:flex;
              // flex-direction:column), so every direct child stretches to
              // the container's full width by the flex default
              // (align-items: stretch) regardless of the pill's own
              // display:inline-block - that only controls how ITS OWN
              // content lays out, not how the flex parent sizes it. Without
              // this override the pill's background/border stretched edge
              // to edge instead of hugging its text.
              style={{ color: 'var(--mauve)', background: 'var(--mauve-tint-1)', padding: '2px 8px', borderRadius: 'var(--radius-sm)', display: 'inline-block', alignSelf: 'flex-start', fontWeight: 600 }}
            >
              {crossRepFloorWarningText(visit.crossRepFloorWarning)}
            </div>
          )}
        </div>
        {editing ? (
          <div className="modal-foot" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ width: '100%' }}>
              <label className="field">Date</label>
              <input
                type="date"
                value={editDate}
                min={today()}
                onChange={(e) => { setEditDate(e.target.value); setEditWarnings(null); setEditError(null); }}
                disabled={savingEdit}
                autoFocus
              />
            </div>
            <div style={{ width: '100%' }}>
              <label className="field">Visit type</label>
              <select
                value={editVisitType}
                onChange={(e) => setEditVisitType(e.target.value)}
                disabled={savingEdit}
              >
                {Object.entries(VISIT_TYPE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>
            <div style={{ width: '100%' }}>
              <label className="field">Notes</label>
              <textarea
                rows={2}
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                disabled={savingEdit}
              />
            </div>
            {/* Left of the buttons, same as VisitLogModal/PlanVisitModal's
                own footer notice - not its own full-width line above them.
                Date/Notes above keep width: 100% (they need the room for
                their own label+input), but this row packs alongside the
                buttons since flexWrap on modal-foot already forces a new
                line after each 100%-wide field.

                flex: 1 + minWidth: 0, NOT marginRight: auto (what this used
                to be). flex-wrap picks its line breaks from each item's
                UNFLEXED content width, so an auto-margined notice sized to
                its own text would claim the whole line the moment the text
                got long - shunting Cancel/Save onto a line of their own -
                even though it would happily have shrunk to share. A
                flex-basis of 0 (via flex: 1) makes that hypothetical width
                zero, so the notice never forces a break and instead grows
                into whatever the buttons leave, which is also the same
                right-alignment the auto margin was there for. minWidth: 0
                lets it actually shrink past min-content, so a long word
                wraps inside the notice rather than overflowing it. */}
            <div ref={noticeRef} style={{ flex: 1, minWidth: 0 }}>
              {editError && (
                editError.conflict
                  // Same reasoning as PlanVisitModal's own blockedAdvice: a
                  // §4.1 block has no "Save anyway" to press, and it's styled
                  // identically to the §4.2 warning right below it, so
                  // without this it reads as an unexplained dead end. The
                  // date is the only colliding field this panel can change
                  // (the visit's place is fixed), so there's nothing to
                  // branch on the way PlanVisitModal has to.
                  ? <div className="tiny" style={{ color: 'var(--mauve)' }}>{editError.message} Pick a different date.</div>
                  : <div className="error-banner">{editError.message}</div>
              )}
              {editWarnings?.length > 0 && (
                <div className="tiny" style={{ color: 'var(--mauve)' }}>
                  {primaryWarning(editWarnings).message}
                </div>
              )}
            </div>
            {/* Not redundant with the modal's own x (UI_SPEC.md Kind 1),
                despite the label: this backs out one LEVEL, to the
                Delete/Edit/Snooze footer, where the x closes the modal
                outright. Same for the Snooze panel's Cancel below. */}
            <Button variant="secondary" size="small" onClick={() => setEditing(false)} disabled={savingEdit}>Cancel</Button>
            <Button size="small" disabled={savingEdit || !editDate} onClick={() => doEdit({ force: !!editWarnings })}>
              {savingEdit ? 'Saving…' : editWarnings ? 'Save anyway' : 'Save'}
            </Button>
          </div>
        ) : snoozing ? (
          <div className="modal-foot" style={{ flexWrap: 'wrap' }}>
            <div className="tiny muted" style={{ width: '100%' }}>Push this place out of rotation until…</div>
            {SNOOZE_PRESETS.map((p) => (
              <Button key={p.days} variant="secondary" size="small" disabled={saving} onClick={() => doSnooze(addDaysISO(p.days))}>
                {p.label}
              </Button>
            ))}
            <input type="date" value={customDate} onChange={(e) => setCustomDate(e.target.value)} disabled={saving} />
            <Button size="small" disabled={saving || !customDate} onClick={() => doSnooze(customDate)}>Set date</Button>
            <Button variant="secondary" size="small" onClick={() => setSnoozing(false)} disabled={saving}>Cancel</Button>
          </div>
        ) : (
          <div className="modal-foot">
            {onDelete && canDelete && (
              <Button
                variant="danger"
                style={{ marginRight: 'auto' }}
                title="Delete this planned visit"
                onClick={() => onDelete(visit)}
              >
                Delete
              </Button>
            )}
            {onEdited && canEdit && (
              <Button
                variant="secondary"
                title="Change this visit's date or notes - takes it over as a manually-planned visit"
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            )}
            {onSnoozed && canSnooze && (
              <Button
                variant="secondary"
                title="Defer this visit - suppresses this place for every rep until the date you pick"
                onClick={() => setSnoozing(true)}
              >
                Snooze
              </Button>
            )}
            {onComplete && (
              <Button title="Log what happened and mark this visit completed" onClick={() => onComplete(visit)}>
                Log this visit
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
