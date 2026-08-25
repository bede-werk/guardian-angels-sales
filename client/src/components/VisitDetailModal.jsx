import React, { useEffect, useState } from 'react';
import { api, formatDate, VISIT_TYPE_LABELS, outcomeLabel, suppressionNote } from '../api';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import useClosingTransition from '../hooks/useClosingTransition';

// Short, joinable labels for a non-named encounter - MET_WITH_LABELS in api.js
// reads as a form option ("A staff member (name unknown)"), too long to sit
// inline in "with X, Y and Z". Exported (with the helpers below) because
// PlaceDetail, PersonDetail and the Visits tab all describe the same
// `encounters` arrays in their visit-history rows; keeping one spelling of
// "a staff member" in the place that owns encounter rendering beats several
// drifting copies.
export const ENCOUNTER_SHORT_LABELS = {
  staff: 'a staff member',
  receptionist: 'the receptionist',
  // Only ever appears alone - 'nobody' is mutually exclusive with every other
  // met_with_type at log time (see VisitLogModal's toggleMetType) - so it
  // never has to read well mid-list.
  nobody: 'nobody',
};

// One encounter as a name: the person if there is one, otherwise the category.
export function encounterLabel(encounter) {
  if (encounter.met_with_type === 'named_person') return encounter.person_name || 'someone';
  return ENCOUNTER_SHORT_LABELS[encounter.met_with_type] || 'someone';
}

// "Flibber Gibblits", "Flibber Gibblits and the receptionist", or
// "Flibber Gibblits, New Guy and a staff member".
export function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// Who was met on one trip, as a single inline phrase: "with Flibber Gibblits,
// New Guy and a staff member". Moved here from PlaceDetail.jsx (its original,
// sole caller) once the Visits tab needed the exact same phrase for its own
// "Who was met" column - a second copy of this one-liner was exactly the
// kind of drift this file's header comment above already argues against.
// List endpoints return only a name-only summary of each trip's encounters
// (full per-encounter detail needs GET /api/visits/:id - see this modal's
// own fetch below), which is exactly enough for this. A planned trip has no
// encounters yet and gets no phrase at all rather than an empty "with".
export function encounterSummary(encounters) {
  if (!encounters || encounters.length === 0) return null;
  return `with ${joinNames(encounters.map(encounterLabel))}`;
}

// discharge_reason -> a short, past-tense label for a visit-history row.
// null (still outstanding) has no label at all - an unresolved promise
// needs no annotation beyond its date.
const COMMITMENT_STATUS_LABELS = { fulfilled: 'fulfilled', superseded: 'rescheduled', waived: 'waived' };

// One commitment made during a visit ("8/20/2026" or "8/20/2026
// (rescheduled)") - just the date + status, no label, since PlaceDetail/
// PersonDetail/this modal each prefix it differently (a bold "Promised next
// visit:" field label here, a plain muted line there). Exported so all
// three share one spelling of the status wording, same "one spelling, not
// three drifting copies" convention as encounterLabel/joinNames above - all
// three now read the same `commitments_made` array (see
// services/placeCommitments.js's attachCommitmentsMade), which replaced the
// old per-visit next_visit_date column.
export function commitmentMadeText(c) {
  const status = c.discharge_reason ? ` (${COMMITMENT_STATUS_LABELS[c.discharge_reason] || c.discharge_reason})` : '';
  return `${formatDate(c.promised_date)}${status}`;
}

// Everything on file for one visit - a TRIP: place, date, rep, notes, and the
// list of people/categories met on it (`encounters`). The list endpoints that
// feed the callers here only return name + category per encounter, so this
// modal always refetches the trip through GET /api/visits/:id, which is the
// only call that returns each encounter's outcome/contact snapshot/"they asked
// for something". That's also why it takes the trip's id and not the row it
// was handed: PlaceDetail and PersonDetail pass different shapes of the same
// trip, and both should show the identical, complete picture.
//
// The encounter list is the interactive part: each person expands in place to
// show what happened with THEM, and can be removed on its own - one person
// being mis-logged shouldn't cost the whole visit.
//
// `onChanged` (optional) fires whenever an encounter was removed, so the
// parent can reload its own list; when the removal took the trip with it (see
// removeEncounter) the modal closes itself as well, since there's nothing
// left to show.
export default function VisitDetailModal({ visit, onClose, onEdit, onDelete, onChanged }) {
  const { closing, requestClose } = useClosingTransition(onClose);
  const [trip, setTrip] = useState(null); // GET /api/visits/:id - the full trip + every encounter field
  const [loadError, setLoadError] = useState(null);
  const [openEncounterId, setOpenEncounterId] = useState(null); // which encounter's detail is expanded, if any
  const [removingEncounterId, setRemovingEncounterId] = useState(null); // encounter currently being deleted (disables its row)

  async function load() {
    try {
      setLoadError(null);
      setTrip(await api.visit(visit.id));
    } catch (e) {
      setLoadError(e.message);
    }
  }
  useEffect(() => {
    load();
  }, [visit.id]);

  // Removing the last encounter from an already-logged trip deletes the trip
  // server-side - a completed visit where nobody was met isn't a record of
  // anything. That cascade is invisible from the row being clicked, so the
  // confirm has to name what actually goes with it: just the notes now.
  // A commitment made during this trip (commitments_made) used to be named
  // here too, back when it lived as a next_visit_date column ON the visit
  // row and deleting the visit deleted it with it. Now it's its own
  // place_commitments row with ON DELETE SET NULL on source_visit_id - the
  // commitment survives a deleted visit, it only loses the "made during
  // this trip" provenance link, so there's nothing lost here worth warning
  // about.
  function lastEncounterConfirm(encounter) {
    const losses = [];
    if (trip.notes) losses.push('its notes');
    return (
      `Removing ${encounterLabel(encounter)} leaves nobody on this visit, so the whole visit will be deleted` +
      (losses.length ? ` - including ${joinNames(losses)}` : '') +
      '.' +
      " This can't be undone. Continue?"
    );
  }

  async function removeEncounter(encounter) {
    // A PLANNED trip legitimately holds no encounters at all - that's its
    // normal pre-completion state - so emptying one doesn't delete it. Every
    // other status is treated as cascading: over-warning costs a sentence in a
    // confirm, under-warning costs a follow-up date nobody knew they lost.
    const deletesTrip = trip.encounters.length === 1 && trip.status === 'completed';
    const message = deletesTrip
      ? lastEncounterConfirm(encounter)
      : `Remove ${encounterLabel(encounter)} from this visit? The rest of the visit stays. This can't be undone.`;
    if (!window.confirm(message)) return;
    setRemovingEncounterId(encounter.id);
    try {
      await api.deleteVisitEncounter(trip.id, encounter.id);
      onChanged?.();
      if (deletesTrip) {
        requestClose();
        return;
      }
      await load();
    } catch (e) {
      window.alert(e.message);
    } finally {
      setRemovingEncounterId(null);
    }
  }

  if (!trip) {
    return (
      <div className={`modal-backdrop${closing ? ' closing' : ''}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
        <div className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
          {loadError ? (
            <div className="stack" style={{ padding: 20 }}>
              <div className="error-banner">{loadError}</div>
              <Button variant="secondary" onClick={requestClose}>Close</Button>
            </div>
          ) : (
            <div className="loading">Loading…</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`modal-backdrop${closing ? ' closing' : ''}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Visit · {trip.scheduled_date ? formatDate(trip.scheduled_date) : 'Unscheduled'}</h2>
          <button className="close" title="Close" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body stack">
          {loadError && <div className="error-banner">{loadError}</div>}

          {/* The trip's own facts - true of the whole visit, stated once,
              however many people it covered. */}
          {trip.place_name && <div className="tiny"><strong>Place:</strong> {trip.place_name}</div>}
          <div className="tiny"><strong>Type:</strong> {VISIT_TYPE_LABELS[trip.visit_type] || 'Visit'}</div>
          {trip.user_name && <div className="tiny"><strong>Logged by:</strong> {trip.user_name}</div>}
          <div className="tiny"><strong>Notes:</strong> {trip.notes || '-'}</div>
          {trip.actual_duration_minutes != null && (
            <div className="tiny"><strong>Took:</strong> {trip.actual_duration_minutes} min</div>
          )}
          {/* commitments_made - the promise(s) this trip made (Place
              Commitments spec §6.3), via source_visit_id - replaces the old
              bare next_visit_date field. Usually 0 or 1, but not enforced
              at the DB level, so every one is shown. The suppression
              caveat only applies to a still-OUTSTANDING promise - one
              already fulfilled/rescheduled/waived isn't "sitting unacted
              on," it's just resolved. */}
          {trip.commitments_made?.map((c) => (
            <div key={c.id} className="tiny">
              <strong>Promised next visit:</strong> {commitmentMadeText(c)}
              {!c.discharged_at &&
                suppressionNote({ snooze_until: trip.place_snooze_until, do_not_visit: trip.place_do_not_visit, do_not_visit_until: trip.place_do_not_visit_until })}
            </div>
          ))}
          {/* No crossRepFloorWarning pill - this modal only ever shows an
              already-completed or already-skipped trip (see VisitsCalendar.jsx;
              a still-planned one is UpcomingVisitDetailModal's job), and the
              warning exists to help a rep pick a different stop before it
              happens. Nothing to act on once it already has. */}

          {/* Who was met. Click a name to see what happened with THEM - the
              outcome and the contact details as they stood that day are facts
              about one encounter, not about the trip, and flattening them into
              the block above is exactly what this split exists to stop. */}
          <div>
            <label className="field">Who was met ({trip.encounters.length})</label>
            {trip.encounters.length === 0 ? (
              <EmptyState
                message={
                  trip.status === 'planned'
                    ? "Nobody recorded yet - this visit hasn't been logged."
                    : 'Nobody was recorded on this visit.'
                }
              />
            ) : (
              <div className="stack encounter-list" style={{ gap: 10 }}>
                {trip.encounters.map((e) => {
                  const open = openEncounterId === e.id;
                  return (
                    <div
                      key={e.id}
                      className="encounter-row hover-row"
                      title={open ? 'Hide what happened' : 'Show what happened with them'}
                      role="button"
                      tabIndex={0}
                      onClick={() => setOpenEncounterId(open ? null : e.id)}
                      onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setOpenEncounterId(open ? null : e.id); } }}
                    >
                      <div className="tag-list" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                        <div className="encounter-name">
                          {open ? '▾' : '▸'} {encounterLabel(e)}
                          {e.person_title ? <span className="muted"> - {e.person_title}</span> : null}
                        </div>
                        <button
                          type="button"
                          className="icon-remove"
                          title="Remove this person from this visit"
                          disabled={removingEncounterId === e.id}
                          onClick={(ev) => { ev.stopPropagation(); removeEncounter(e); }}
                        >
                          ✕
                        </button>
                      </div>
                      {open && (
                        <div className="stack" style={{ gap: 6 }}>
                          {e.outcome ? (
                            <div className="tiny"><strong>Outcome:</strong> {outcomeLabel(e.outcome)}</div>
                          ) : (
                            <div className="tiny muted">No outcome recorded.</div>
                          )}
                          {/* Only worth stating when it happened - "no" is the
                              default for every encounter and says nothing. The
                              ✓ marks this as an already-recorded fact, not an
                              open call to action the rep still owes someone. */}
                          {e.they_requested && (
                            <div className="tiny" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span aria-hidden="true" style={{ color: 'var(--teal-dark)', fontWeight: 700 }}>✓</span>
                              They asked us for something.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
          <Button variant="danger" title="Delete this visit and everyone on it" onClick={() => onDelete?.(trip)}>Delete</Button>
          <div style={{ display: 'flex', gap: 10 }}>
            {/* Hands the FULL trip up, not the row the parent opened this
                with, so VisitLogModal starts from every encounter already on
                file instead of the list endpoint's name-only summary. */}
            <Button variant="secondary" title="Edit this visit's details" onClick={() => onEdit?.(trip)}>Edit</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
