import React, { useEffect, useState } from 'react';
import { api, navigateUrl, formatDate, crossRepFloorWarningText, VISIT_TYPE_LABELS, isSnoozeActive, isDoNotVisitActive, suppressionNote } from '../api';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import VisitLogModal from './VisitLogModal';
import PlanVisitModal from './PlanVisitModal';
import PersonModal from './PersonModal';
import PlaceModal from './PlaceModal';
import AssignPersonModal from './AssignPersonModal';
import PersonDetail from './PersonDetail';
import ReferralModal from './ReferralModal';
import VisitDetailModal, { encounterLabel, joinNames, commitmentMadeText } from './VisitDetailModal';
import UpcomingVisitDetailModal from './UpcomingVisitDetailModal';
import { PlaceRelationship } from './RelationshipDetail';
import { PlaceCapacity } from './CapacityDetail';
import { PlaceCommitments } from './PlaceCommitments';
import useClosingTransition from '../hooks/useClosingTransition';

// Who was met on one trip, as a single inline phrase: "with Flibber Gibblits,
// New Guy and a staff member". The visit list endpoint returns a name-only
// summary of each trip's encounters (full per-encounter detail needs
// GET /api/visits/:id — see VisitDetailModal), which is exactly enough for
// this. A planned trip has no encounters yet and gets no phrase at all rather
// than an empty "with".
function encounterSummary(encounters) {
  if (!encounters || encounters.length === 0) return null;
  return `with ${joinNames(encounters.map(encounterLabel))}`;
}

// Presets for the "Do not visit until…" panel — longer-scale than
// UpcomingVisitDetailModal's own SNOOZE_PRESETS (1/2 weeks, 1 month) on
// purpose: do-not-visit is a deliberate "stop proposing this place" call,
// not a short rotation nudge, so the defaults skew toward the kind of
// horizon that decision actually needs. Same "+N days, not a calendar month"
// math as that panel, for the same reason (a plain date-string add, no
// month-length edge cases).
const DO_NOT_VISIT_PRESETS = [
  { label: '1 month', days: 30 },
  { label: '3 months', days: 90 },
  { label: '6 months', days: 180 },
];

function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Slide-in modal: place details + people here + full visit history + "log a
// visit" action. Opened from Places.jsx (clicking a row) or Dashboard.jsx
// (clicking any place-linked row/card).
export default function PlaceDetail({ placeId, userId, onClose, onChanged, onDeleted }) {
  const { closing, startClosing } = useClosingTransition();
  const requestClose = () => startClosing(onClose);
  const [data, setData] = useState(null); // GET /api/places/:id response (place + visits + people)
  const [loadError, setLoadError] = useState(null);
  const [categories, setCategories] = useState([]); // known category names, for PlaceModal's autocomplete
  const [editing, setEditing] = useState(false); // whether the Edit place modal is open
  const [logging, setLogging] = useState(false); // whether the Log Visit modal is open
  // Controls the (Create/Edit) person modal: undefined = closed, null =
  // creating a brand-new person, an object = editing that existing person.
  const [editingPerson, setEditingPerson] = useState(undefined);
  const [assigningPerson, setAssigningPerson] = useState(false); // "Assign person" (pick someone already on file) modal
  const [selectedPersonId, setSelectedPersonId] = useState(null); // whose full PersonDetail is open, if any
  const [removingPersonId, setRemovingPersonId] = useState(null); // person currently being detached (disables their row)
  const [loggingReferral, setLoggingReferral] = useState(false); // whether the Log Referral modal is open
  const [deleting, setDeleting] = useState(false);
  const [removingVisitId, setRemovingVisitId] = useState(null); // visit currently being deleted (disables its row)
  const [viewingVisit, setViewingVisit] = useState(null); // visit whose full detail popup is open, if any
  const [viewingUpcomingVisit, setViewingUpcomingVisit] = useState(null); // upcoming (planned) visit whose read-only popup is open, if any
  const [editingVisit, setEditingVisit] = useState(null); // visit currently open in VisitLogModal for editing, if any
  // Durable, org-level notes (separate from any single visit's notes or a
  // person's notes) — editable inline via a small textarea + Save.
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [removingNotes, setRemovingNotes] = useState(false);
  const [liftingSnooze, setLiftingSnooze] = useState(false);
  // Do-not-visit panel on the Upcoming Visits card — same "editor state
  // lives in this component, not the card itself" shape as the snooze flag
  // above, since both act on `data.id` directly with no per-row target.
  const [markingDoNotVisit, setMarkingDoNotVisit] = useState(false);
  const [dnvCustomDate, setDnvCustomDate] = useState('');
  const [savingDoNotVisit, setSavingDoNotVisit] = useState(false);
  const [liftingDoNotVisit, setLiftingDoNotVisit] = useState(false);
  // Manual relationship override (see RelationshipDetail.jsx). The editor's
  // own open/closed state lives in that component; only the in-flight save
  // needs to be known here, since this is what triggers the reload.
  const [savingRelationship, setSavingRelationship] = useState(false);
  // Capacity (see CapacityDetail.jsx) — same "editor state lives in the
  // child component" convention as relationship above. Two separate
  // in-flight flags since the override and a fresh observation are two
  // independent actions that can't collide (the child only ever shows one
  // editor open at a time).
  const [savingCapacityOverride, setSavingCapacityOverride] = useState(false);
  const [savingCapacityObservation, setSavingCapacityObservation] = useState(false);
  // Place Commitments (see PlaceCommitments.jsx) — same "editor state lives
  // in the child, only the in-flight save flag lives here" convention as
  // capacity's pair above. waivingCommitmentId (not a plain boolean) so only
  // the row actually being waived shows "Waiving…", not every row at once.
  const [savingCommitment, setSavingCommitment] = useState(false);
  const [reschedulingCommitmentSaving, setReschedulingCommitmentSaving] = useState(false);
  const [waivingCommitmentId, setWaivingCommitmentId] = useState(null);
  const [deletingCommitmentId, setDeletingCommitmentId] = useState(null);
  // Manual Visit Planning (see server's manual-visit-planning-spec.md §3) —
  // the "Plan a visit…" button in the Upcoming Visits card-head, next to Do
  // not visit…. Opens PlanVisitModal rather than an inline form (that used
  // to cram date + rep picker + warning text into one card row).
  const [planningVisit, setPlanningVisit] = useState(false);
  const [users, setUsers] = useState([]); // team list, for the assigned-rep picker (cross-rep planning, §5)

  async function load() {
    try {
      setLoadError(null);
      setData(await api.place(placeId));
    } catch (e) {
      setLoadError(e.message);
    }
  }
  useEffect(() => {
    load();
  }, [placeId]);
  useEffect(() => {
    api.filters().then((f) => setCategories(f.allCategories)).catch(() => {});
  }, []);
  useEffect(() => {
    api.users.list().then(setUsers).catch(() => {});
  }, []);

  // Permanently removes only the place itself. People who were here are
  // detached (not deleted) and every visit logged here survives, still
  // visible from each person's own page — only this place's own record is
  // gone for good.
  async function deletePlace() {
    if (!window.confirm(`Delete ${data.name}? People who were here will stay on file (just unassigned from this place), and all visit history is preserved. This can't be undone.`)) return;
    setDeleting(true);
    try {
      await api.deletePlace(data.id);
      onDeleted?.();
      requestClose();
    } catch (e) {
      window.alert(e.message);
      setDeleting(false);
    }
  }

  async function saveNotes() {
    setSavingNotes(true);
    try {
      await api.updatePlace(data.id, { notes: notesDraft });
      setEditingNotes(false);
      load();
      onChanged?.();
    } catch (e) {
      window.alert(e.message);
    } finally {
      setSavingNotes(false);
    }
  }

  async function removeNotes() {
    if (!window.confirm("Remove this note? This can't be undone.")) return;
    setRemovingNotes(true);
    try {
      await api.updatePlace(data.id, { notes: null });
      setEditingNotes(false);
      load();
      onChanged?.();
    } catch (e) {
      window.alert(e.message);
    } finally {
      setRemovingNotes(false);
    }
  }

  // Sets (or, with null, clears) the manual relationship override. The
  // server stamps who/when — see routes/places.js — so nothing about the
  // attribution is client-supplied. Returns false on failure so the editor
  // stays open with the user's choice intact rather than silently closing.
  async function saveRelationshipOverride(level) {
    setSavingRelationship(true);
    try {
      await api.updatePlace(data.id, { relationship_level_override: level });
      load();
      onChanged?.();
      return true;
    } catch (e) {
      window.alert(e.message);
      return false;
    } finally {
      setSavingRelationship(false);
    }
  }

  // Same override pattern, capacity's own field pair (level + free-text
  // reason — see 20260807000001_add_place_capacity_override.js). `reason`
  // is only meaningful alongside a real level; clearing (level: null) drops
  // it too, same "stale attribution on a cleared override would be a lie"
  // rule relationship's own override already follows.
  async function saveCapacityOverride(level, reason) {
    setSavingCapacityOverride(true);
    try {
      await api.updatePlace(data.id, { capacity_override_level: level, capacity_override_reason: level ? reason : null });
      load();
      onChanged?.();
      return true;
    } catch (e) {
      window.alert(e.message);
      return false;
    } finally {
      setSavingCapacityOverride(false);
    }
  }

  // Appends a fresh capacity_observations row — never overwrites the
  // previous one (see that table's own migration header). value is
  // whatever raw string the number input held; rounded client-side for the
  // same reason the old pre-qual field used to (a non-integer silently
  // fails the server's own validation rather than producing a useful error).
  async function addCapacityObservation(value) {
    setSavingCapacityObservation(true);
    try {
      const rounded = Math.max(0, Math.round(Number(value)));
      await api.addCapacityObservation(data.id, { monthly_referrals: rounded });
      load();
      onChanged?.();
      return true;
    } catch (e) {
      window.alert(e.message);
      return false;
    } finally {
      setSavingCapacityObservation(false);
    }
  }

  // Adds a dated promise directly, no visit involved — PlaceCommitments'
  // own "Add…" control (see services/placeCommitments.js's module header:
  // place-level, cross-rep, more than one outstanding promise is allowed).
  async function addCommitment(promisedDate, personId, note) {
    setSavingCommitment(true);
    try {
      await api.addCommitment(data.id, { promised_date: promisedDate, person_id: personId, note });
      load();
      onChanged?.();
      return true;
    } catch (e) {
      window.alert(e.message);
      return false;
    } finally {
      setSavingCommitment(false);
    }
  }

  // Discharges the original as superseded and creates a new outstanding
  // commitment for the new date (spec §6.2) — the server carries
  // person_id/note forward unless this call overrides them.
  async function rescheduleCommitment(commitmentId, promisedDate, personId, note) {
    setReschedulingCommitmentSaving(true);
    try {
      await api.rescheduleCommitment(data.id, commitmentId, { promised_date: promisedDate, person_id: personId, note });
      load();
      onChanged?.();
      return true;
    } catch (e) {
      window.alert(e.message);
      return false;
    } finally {
      setReschedulingCommitmentSaving(false);
    }
  }

  // Discharges as waived — "not happening; back to normal cadence." The
  // place immediately stops binding to this promise (see getBindingCommitment).
  async function waiveCommitment(commitmentId, note) {
    setWaivingCommitmentId(commitmentId);
    try {
      await api.waiveCommitment(data.id, commitmentId, { note });
      load();
      onChanged?.();
      return true;
    } catch (e) {
      window.alert(e.message);
      return false;
    } finally {
      setWaivingCommitmentId(null);
    }
  }

  // Hard-deletes a discharged commitment — history cleanup only (the server
  // rejects this on a still-outstanding one; waive/reschedule it first).
  async function deleteCommitment(commitmentId) {
    if (!window.confirm("Delete this commitment from history? This can't be undone.")) return;
    setDeletingCommitmentId(commitmentId);
    try {
      await api.deleteCommitment(data.id, commitmentId);
      load();
      onChanged?.();
    } catch (e) {
      window.alert(e.message);
    } finally {
      setDeletingCommitmentId(null);
    }
  }

  // Marks (or re-marks) do_not_visit with an explicit until-date — null
  // means indefinite. Always writes do_not_visit and do_not_visit_until
  // together (see places.js's EDITABLE comment): a stale until date left
  // over from an already-lapsed mark must never silently cap a fresh one.
  // Also the dismissible zero-capacity suggestion's action button (see
  // CapacityDetail.jsx) — do_not_visit only ever SKIPS this place in future
  // route proposals, it never deletes or hides anything already on file, so
  // no confirm is needed here.
  async function setDoNotVisit(until) {
    setSavingDoNotVisit(true);
    try {
      await api.updatePlace(data.id, { do_not_visit: true, do_not_visit_until: until || null });
      setMarkingDoNotVisit(false);
      setDnvCustomDate('');
      load();
      onChanged?.();
    } catch (e) {
      window.alert(e.message);
    } finally {
      setSavingDoNotVisit(false);
    }
  }

  async function liftDoNotVisit() {
    setLiftingDoNotVisit(true);
    try {
      await api.updatePlace(data.id, { do_not_visit: false, do_not_visit_until: null });
      load();
      onChanged?.();
    } catch (e) {
      window.alert(e.message);
    } finally {
      setLiftingDoNotVisit(false);
    }
  }

  // Clears the place-level suppression early (POST /api/visits/:id/snooze —
  // fired from UpcomingVisitDetailModal — is the only way it gets set). The
  // visit that set it keeps its own 'snoozed' record; this only undoes what
  // schedulingEngine.js's eligibility() reads.
  async function liftSnooze() {
    setLiftingSnooze(true);
    try {
      await api.unsnoozePlace(data.id);
      load();
      onChanged?.();
    } catch (e) {
      window.alert(e.message);
    } finally {
      setLiftingSnooze(false);
    }
  }

  // Detaches a person from this place (place_id -> null) without deleting
  // them — same as PersonDetail's own "Remove from place", just reachable
  // straight from the list here too.
  async function removePerson(person) {
    if (!window.confirm(`Remove ${person.name} from ${data.name}? Their visit history will stay on file.`)) return;
    setRemovingPersonId(person.id);
    try {
      await api.people.update(person.id, { place_id: null });
      load();
      onChanged?.();
    } catch (e) {
      window.alert(e.message);
    } finally {
      setRemovingPersonId(null);
    }
  }

  // Deletes a whole trip — every encounter on it goes with it (the FK
  // cascades server-side), and it's the same trip PersonDetail reads, so
  // removing it here removes it there on next load too. Dropping only ONE
  // person from a trip is VisitDetailModal's per-encounter ✕, not this.
  // Also reused for a still-planned (status: 'planned') visit via
  // UpcomingVisitDetailModal's own Delete button below — those have no
  // encounters yet, hence the conditional clause.
  async function removeVisit(visit) {
    const warning = visit.encounters?.length ? ' Everyone recorded on it goes with it.' : '';
    if (!window.confirm(`Delete this visit?${warning} This can't be undone.`)) return;
    setRemovingVisitId(visit.id);
    try {
      await api.deleteVisit(visit.id);
      load();
      onChanged?.();
    } catch (e) {
      window.alert(e.message);
    } finally {
      setRemovingVisitId(null);
    }
  }

  // Show a lightweight loading modal while the initial fetch is in flight.
  if (!data) {
    return (
      <div className={`modal-backdrop${closing ? ' closing' : ''}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
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

  // Clicking the backdrop backs out of an in-progress inline notes edit
  // instead of closing the whole card out from under it — a second backdrop
  // click (with nothing left open) closes the card as normal. stopPropagation
  // so this doesn't bubble up to any ancestor modal-backdrop this card might
  // itself be nested inside.
  function handleBackdropClick(e) {
    e.stopPropagation();
    if (editingNotes) {
      setEditingNotes(false);
    } else {
      requestClose();
    }
  }

  return (
    <div className={`modal-backdrop${closing ? ' closing' : ''}`} onClick={handleBackdropClick}>
      {/* stopPropagation so clicking inside the modal doesn't bubble up to the
          backdrop's onClick (which would close the modal). */}
      <div className="modal" style={{ maxWidth: 1040 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="tag-list" style={{ alignItems: 'center' }}>
              <h2 style={{ fontSize: 22 }}>{data.name}</h2>
              <span className="badge" style={{ background: 'var(--teal-tint-2)', color: 'var(--teal-dark)' }}>
                {data.referral_metrics.lifetime_referrals} referral{data.referral_metrics.lifetime_referrals === 1 ? '' : 's'}
              </span>
            </div>
          </div>
          <button className="close" title="Close" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body">
          {loadError && <div className="error-banner">{loadError}</div>}
          {/* Contact Info, Details, and Relationship in one row — Details
              (just standing notes) is the simplest of the three, so it's
              what keeps this row short; People (busier — a scrollable list
              plus header actions) moved down to pair with Capacity instead.
              Contact Info/Relationship stay pinned to a fixed width (wide
              enough that Relationship's status+trend never wraps). No fixed
              height here (unlike the two rows below) — this row's content is
              always short and bounded (address, one notes field, a status
              line), so it can just size to whatever it actually needs. */}
          <div style={{ display: 'flex', gap: 14, alignItems: 'stretch' }}>
            <div className="card" style={{ flex: '0 0 250px', display: 'flex', flexDirection: 'column' }}>
              <div className="card-head"><h2>Contact Info</h2></div>
              <div className="card-body stack" style={{ flex: 1, justifyContent: 'center' }}>
                <div className="tiny">
                  {data.address && <div>{data.address}</div>}
                  <div>{data.city}, {data.state} {data.zip} · <strong>{data.region}</strong></div>
                  {data.phone && <div>{data.phone}</div>}
                </div>
              </div>
            </div>

            {/* Durable notes about the organization itself — not tied to any one
                visit or person (e.g. "front desk is picky about walk-ins"). */}
            <div className="card" style={{ flex: 1, minWidth: 0 }}>
              <div className="card-head">
                <h2>Details</h2>
                <div className="tag-list" style={{ flex: 'unset' }}>
                  {!data.notes && !editingNotes && (
                    <Button
                      variant="secondary"
                      size="small"
                      title="Add a standing note about this place"
                      onClick={() => { setNotesDraft(''); setEditingNotes(true); }}
                    >
                      Add notes
                    </Button>
                  )}
                </div>
              </div>
              <div className="card-body stack">
                {/* Snooze/do-not-visit status + controls moved to the Upcoming
                    Visits card below (2026-08-10) — that's where a rep is
                    already looking to answer "why hasn't this place come up in
                    routing?", and where the do-not-visit action now lives too. */}
                {data.skipped_visit_count > 0 && (
                  <div className="tiny muted">
                    Skipped {data.skipped_visit_count} time{data.skipped_visit_count === 1 ? '' : 's'} — planned, then never visited.
                  </div>
                )}
                {editingNotes ? (
                  <div className="stack">
                    <textarea
                      rows={2}
                      value={notesDraft}
                      onChange={(e) => setNotesDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNotes(); } }}
                      autoFocus
                    />
                    <div className="tag-list" style={{ justifyContent: 'space-between' }}>
                      {data.notes ? (
                        <Button variant="danger" size="small" title="Delete this note — can't be undone" onClick={removeNotes} disabled={removingNotes || savingNotes}>
                          {removingNotes ? 'Deleting…' : 'Delete'}
                        </Button>
                      ) : <span />}
                      <div className="tag-list">
                        <Button variant="secondary" size="small" title="Discard without saving" onClick={() => setEditingNotes(false)} disabled={savingNotes || removingNotes}>
                          Cancel
                        </Button>
                        <Button size="small" title="Save this note" onClick={saveNotes} disabled={savingNotes || removingNotes}>
                          {savingNotes ? 'Saving…' : 'Save'}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : data.notes ? (
                  <div className="tiny hover-row" style={{ padding: '8px', margin: '-8px', borderRadius: 6 }} title="Click to edit" onClick={() => { setNotesDraft(data.notes || ''); setEditingNotes(true); }}>
                    <strong>Notes:</strong> {data.notes}
                  </div>
                ) : (
                  // Plain small muted line, not the full illustrated EmptyState
                  // (too tall for this compact card, especially now that the
                  // pre-qualification line above already fills the "nothing
                  // set yet" role for this card).
                  <div className="tiny muted">No standing notes about this place yet.</div>
                )}
              </div>
            </div>

            <div className="card" style={{ flex: '0 0 250px' }}>
              <div className="card-head"><h2>Relationship</h2></div>
              <div className="card-body stack">
                <PlaceRelationship
                  relationship={data.relationship}
                  onSave={saveRelationshipOverride}
                  saving={savingRelationship}
                />
              </div>
            </div>
          </div>

          {/* People + Capacity on the next line — both are the denser,
              scrollable cards, same fixed-height/scroll pattern as
              PersonDetail's Details/Referrals row. */}
          <div style={{ display: 'flex', gap: 14, alignItems: 'stretch' }}>
            {/* People here: names, click one to open their full detail
                (PersonDetail) — each person's own referral metrics show in
                their row (the per-person breakdown); the place-level roll-up
                lives up top next to the category/tier badges, and again below
                as a one-line summary since it's important place-level info. */}
            <div className="card" style={{ flex: 1, minWidth: 0, height: 240, display: 'flex', flexDirection: 'column' }}>
              <div className="card-head">
                <h2>People ({data.people.length})</h2>
                <div className="tag-list" style={{ flex: 'unset' }}>
                  <Button variant="secondary" size="small" title="Link an existing person on file to this place" onClick={() => { setEditingNotes(false); setAssigningPerson(true); }}>Assign person</Button>
                  <Button variant="secondary" size="small" title="Create a brand-new person here" onClick={() => { setEditingNotes(false); setEditingPerson(null); }}>New person</Button>
                  <Button size="small" title="Record a referral from someone at this place" onClick={() => { setEditingNotes(false); setLoggingReferral(true); }}>Log a referral</Button>
                </div>
              </div>
              <div className="card-body stack" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                <div className="tiny muted">
                  Last referral: {data.referral_metrics.last_referral_date ? formatDate(data.referral_metrics.last_referral_date) : 'none yet'} · {data.referral_metrics.referrals_last_90_days} in the last 90 days
                </div>
                {data.people.length === 0 ? (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <EmptyState message="No one on file here yet." compact />
                  </div>
                ) : (
                  <ul className="list">
                    {data.people.map((p) => (
                      <li
                        key={p.id}
                        className="stop hover-row"
                        style={{ justifyContent: 'space-between', alignItems: 'center' }}
                        onClick={() => { setEditingNotes(false); setSelectedPersonId(p.id); }}
                      >
                        <div className="main">
                          <div className="name">{p.name}</div>
                          {p.title && <div className="meta">{p.title}</div>}
                        </div>
                        <div className="tag-list" style={{ flex: 'unset' }}>
                          <span className="tiny muted">
                            {p.referral_metrics.lifetime_referrals} referral{p.referral_metrics.lifetime_referrals === 1 ? '' : 's'}
                            {p.referral_metrics.last_referral_date ? ` · last ${formatDate(p.referral_metrics.last_referral_date)}` : ''}
                          </span>
                          <Button
                            variant="ghost"
                            size="small"
                            title="Unassign person — they stay on file, just no longer linked to this place"
                            disabled={removingPersonId === p.id}
                            onClick={(e) => { e.stopPropagation(); removePerson(p); }}
                          >
                            ✕
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* Capacity (capacity-computation-spec.md) — the OTHER cadence
                axis, has more to explain than Relationship's short version
                (resolution source, staleness, override, observation
                history) — see CapacityDetail.jsx. */}
            <div className="card" style={{ flex: 1, minWidth: 0, height: 240, display: 'flex', flexDirection: 'column' }}>
              <div className="card-head"><h2>Capacity</h2></div>
              <div className="card-body stack" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                <PlaceCapacity
                  place={data}
                  capacity={data.capacity}
                  observations={data.capacity_observations}
                  onSaveOverride={saveCapacityOverride}
                  savingOverride={savingCapacityOverride}
                  onAddObservation={addCapacityObservation}
                  savingObservation={savingCapacityObservation}
                  onMarkDoNotVisit={() => setDoNotVisit(null)}
                />
              </div>
            </div>
          </div>

          {/* Upcoming Visits + Visit History on the last line, same
              fixed-height/scroll pattern as the row above. */}
          <div style={{ display: 'flex', gap: 14, alignItems: 'stretch' }}>
          {/* Still-open route-planner-committed visits, soonest first. View
              only for now — editing a planned visit will come later, through
              the same Route Planner/schedule-drafts flow a route's own days
              already use, not this card. */}
          <div className="card" style={{ flex: 1, minWidth: 0, height: 268, display: 'flex', flexDirection: 'column' }}>
            <div className="card-head">
              <h2>Upcoming Visits ({data.upcoming_visits.length})</h2>
              <div className="tag-list" style={{ flex: 'unset' }}>
                {/* Manual Visit Planning (spec §3) — "I'm going to Tabitha
                    on Thursday," said directly, no route-planner draft
                    involved. Opens PlanVisitModal. Sits next to Do not
                    visit… here rather than its own row further down — same
                    "card-head is where this card's actions live" precedent
                    the People card's Assign/New/Log a referral row already
                    sets. */}
                <Button
                  variant="secondary"
                  size="small"
                  title="Schedule a future visit directly, without the route planner"
                  onClick={() => setPlanningVisit(true)}
                >
                  Plan a visit…
                </Button>
                {!isDoNotVisitActive(data) && !markingDoNotVisit && (
                  <Button
                    variant="caution"
                    size="small"
                    title="Stop proposing this place in the route planner"
                    onClick={() => setMarkingDoNotVisit(true)}
                  >
                    Do not visit…
                  </Button>
                )}
              </div>
            </div>
            <div className="card-body stack" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              {/* The only visible answer to "why hasn't this place come up in
                  routing?" — both flags act on the whole place, not any one
                  visit, so they live here rather than inside a specific
                  upcoming visit's own popup. Plain text + a small secondary
                  action, not a warning — both are deliberate rep choices,
                  not problems. */}
              {isSnoozeActive(data) && (
                <div className="tag-list" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <div className="tiny">Snoozed — out of routing until {formatDate(data.snooze_until)}.</div>
                  <Button variant="secondary" size="small" onClick={liftSnooze} disabled={liftingSnooze} title="Make this place eligible for routing again now">
                    {liftingSnooze ? 'Lifting…' : 'Lift snooze'}
                  </Button>
                </div>
              )}
              {isDoNotVisitActive(data) && (
                <div className="tag-list" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <div className="tiny">
                    Do not visit — {data.do_not_visit_until ? `until ${formatDate(data.do_not_visit_until)}` : 'indefinitely'}.
                  </div>
                  <span className="tag-list" style={{ flex: 'unset' }}>
                    <Button variant="secondary" size="small" onClick={() => setMarkingDoNotVisit(true)} title="Change the until-date" disabled={liftingDoNotVisit}>
                      Change
                    </Button>
                    <Button variant="secondary" size="small" onClick={liftDoNotVisit} disabled={liftingDoNotVisit} title="Make this place eligible for routing again now">
                      {liftingDoNotVisit ? 'Lifting…' : 'Lift'}
                    </Button>
                  </span>
                </div>
              )}
              {markingDoNotVisit && (
                <div className="tag-list" style={{ flexWrap: 'wrap' }}>
                  <div className="tiny muted" style={{ width: '100%' }}>Stop proposing this place in the route planner until…</div>
                  {DO_NOT_VISIT_PRESETS.map((p) => (
                    <Button key={p.days} variant="secondary" size="small" disabled={savingDoNotVisit} onClick={() => setDoNotVisit(addDaysISO(p.days))}>
                      {p.label}
                    </Button>
                  ))}
                  <Button variant="secondary" size="small" disabled={savingDoNotVisit} onClick={() => setDoNotVisit(null)}>
                    Indefinitely
                  </Button>
                  <input type="date" value={dnvCustomDate} onChange={(e) => setDnvCustomDate(e.target.value)} disabled={savingDoNotVisit} />
                  <Button size="small" disabled={savingDoNotVisit || !dnvCustomDate} onClick={() => setDoNotVisit(dnvCustomDate)}>Set date</Button>
                  <Button variant="secondary" size="small" onClick={() => { setMarkingDoNotVisit(false); setDnvCustomDate(''); }} disabled={savingDoNotVisit}>Cancel</Button>
                </div>
              )}

              {/* Dated promises to return — replaces the old bare
                  visits.next_visit_date line below the Visit History card
                  (see PlaceCommitments.jsx / services/placeCommitments.js).
                  Lives here, not down in Visit History, because a
                  commitment constrains the PLANNER going forward — the same
                  reason snooze/do-not-visit live in this card. */}
              <PlaceCommitments
                commitments={data.commitments}
                people={data.people}
                onAdd={addCommitment}
                saving={savingCommitment}
                onReschedule={rescheduleCommitment}
                rescheduling={reschedulingCommitmentSaving}
                onWaive={waiveCommitment}
                waivingId={waivingCommitmentId}
                onDelete={deleteCommitment}
                deletingId={deletingCommitmentId}
              />

              {data.upcoming_visits.length > 0 && (
                <ul className="list">
                  {data.upcoming_visits.map((v) => (
                    <li
                      key={v.id}
                      className="stack hover-row"
                      style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}
                      onClick={() => { setEditingNotes(false); setViewingUpcomingVisit(v); }}
                    >
                      <div className="tag-list" style={{ justifyContent: 'space-between' }}>
                        <div className="tag-list" style={{ flex: 'unset' }}>
                          <strong className="tiny">{formatDate(v.scheduled_date)}</strong>
                          {/* A planned stop normally has no encounters yet, so
                              this is usually just the rep's name. */}
                          {(v.user_name || v.encounters?.length) && (
                            <span className="tiny muted">
                              · {[v.user_name, encounterSummary(v.encounters)].filter(Boolean).join(' ')}
                            </span>
                          )}
                        </div>
                        <span className="tiny muted" style={{ whiteSpace: 'nowrap' }}>
                          {VISIT_TYPE_LABELS[v.visit_type] || 'Visit'}
                        </span>
                      </div>
                      {v.notes && <div className="tiny">{v.notes}</div>}
                      {v.crossRepFloorWarning && (
                        <div
                          className="tiny"
                          style={{ color: 'var(--mauve)', background: 'var(--mauve-tint-1)', padding: '2px 8px', borderRadius: 'var(--radius-sm)', display: 'inline-block', fontWeight: 600 }}
                        >
                          {crossRepFloorWarningText(v.crossRepFloorWarning)}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Every visit ever logged on this place, most recent first. One row
              per TRIP: the server groups the encounters (see routes/visits.js),
              so a visit where three people were met is one entry here listing
              all three, not three entries. Clicking it opens the trip, where
              each person can be opened on their own.

              No crossRepFloorWarning pill here (unlike the Upcoming Visits
              card above) — this list is always status: 'completed' (see
              routes/places.js), and the warning exists to help a rep pick a
              different stop before it happens. Once it's already happened,
              there's nothing left to act on. */}
          <div className="card" style={{ flex: 1, minWidth: 0, height: 268, display: 'flex', flexDirection: 'column' }}>
            <div className="card-head">
              <h2>Visit History ({data.visits.length})</h2>
              <Button size="small" title="Record a visit to this place" onClick={() => { setEditingNotes(false); setLogging(true); }}>Log a visit</Button>
            </div>
            <div className="card-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              {data.visits.length === 0 ? (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <EmptyState message="No visits logged yet." />
                </div>
              ) : (
                <ul className="list">
                  {data.visits.map((v) => (
                    <li
                      key={v.id}
                      className="hover-row"
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderTop: '1px solid var(--border)' }}
                      onClick={() => { setEditingNotes(false); setViewingVisit(v); }}
                    >
                      {/* minWidth:0 so a long "with A, B and C" line wraps
                          within its own column instead of pushing the delete
                          button wider. The delete button lives as a sibling of
                          this whole stack (not nested in its first line) so it
                          centers against the full row, notes/next-visit lines
                          included, not just the date line. */}
                      <div className="stack" style={{ minWidth: 0 }}>
                        <div className="tag-list" style={{ minWidth: 0 }}>
                          <strong className="tiny">{v.scheduled_date ? formatDate(v.scheduled_date) : 'unscheduled'}</strong>
                          {/* "Lisa Marks with Flibber Gibblits, New Guy and a
                              staff member" — who visited, then everyone they met. */}
                          {(v.user_name || v.encounters?.length) && (
                            <span className="tiny muted">
                              · {[v.user_name, encounterSummary(v.encounters)].filter(Boolean).join(' ')}
                            </span>
                          )}
                        </div>
                        {v.notes && <div className="tiny">{v.notes}</div>}
                        {/* commitments_made — the promise(s) this visit made
                            (Place Commitments spec §6.3), via source_visit_id;
                            replaces the old bare next_visit_date field. The
                            suppression caveat only applies to a still-
                            OUTSTANDING promise: an active place-level snooze/
                            do-not-visit suppresses this place entirely
                            (schedulingEngine.js's eligibility() does not let a
                            due commitment bypass either), so while one is
                            active, an unresolved promise sits unacted on
                            until it lifts — a promise already fulfilled/
                            rescheduled/waived has nothing left to suppress. */}
                        {v.commitments_made?.map((c) => (
                          <div key={c.id} className="tiny muted">
                            Promised next visit: {commitmentMadeText(c)}
                            {!c.discharged_at && suppressionNote(data)}
                          </div>
                        ))}
                      </div>
                      <Button
                        variant="danger"
                        size="small"
                        title="Delete this whole visit, everyone on it included"
                        disabled={removingVisitId === v.id}
                        onClick={(e) => { e.stopPropagation(); removeVisit(v); }}
                        style={{ flexShrink: 0 }}
                      >
                        ✕
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          </div>
        </div>
        <div className="modal-foot">
          <Button
            variant="danger"
            style={{ marginRight: 'auto' }}
            title="Permanently delete this place — can't be undone. People and visit history stay on file, just no longer linked to it."
            onClick={deletePlace}
            disabled={deleting}
          >
            {deleting ? 'Deleting…' : 'Delete place'}
          </Button>
          <Button variant="secondary" title="Edit this place's details" onClick={() => { setEditingNotes(false); setEditing(true); }}>Edit</Button>
        </div>
      </div>

      {editing && (
        <PlaceModal
          place={data}
          categories={categories}
          onClose={() => setEditing(false)}
          onSaved={() => { load(); onChanged?.(); }}
        />
      )}

      {/* Ad-hoc visit logging — not tied to today's generated route, just this place. */}
      {logging && (
        <VisitLogModal
          placeId={data.id}
          placeName={data.name}
          userId={userId}
          onClose={() => setLogging(false)}
          onSaved={() => { load(); onChanged?.(); }}
        />
      )}

      {/* Create/Edit person modal — only rendered when editingPerson isn't undefined. */}
      {editingPerson !== undefined && (
        <PersonModal
          placeId={data.id}
          placeName={data.name}
          person={editingPerson}
          onClose={() => setEditingPerson(undefined)}
          onSaved={() => { load(); onChanged?.(); }}
        />
      )}

      {/* "Assign person" — assign someone who already exists elsewhere (or is
          unassigned) to this place, instead of creating a new record. */}
      {assigningPerson && (
        <AssignPersonModal
          placeId={data.id}
          placeName={data.name}
          onClose={() => setAssigningPerson(false)}
          onAssigned={() => { load(); onChanged?.(); }}
        />
      )}

      {/* Clicking a name in "People here" opens their full detail on top of
          this one. onOpenPlace just closes it back to this same place. */}
      {selectedPersonId && (
        <PersonDetail
          personId={selectedPersonId}
          userId={userId}
          onClose={() => setSelectedPersonId(null)}
          onChanged={() => { load(); onChanged?.(); }}
          onDeleted={() => { setSelectedPersonId(null); load(); onChanged?.(); }}
          onOpenPlace={() => setSelectedPersonId(null)}
        />
      )}

      {loggingReferral && (
        <ReferralModal
          people={data.people}
          onClose={() => setLoggingReferral(false)}
          onSaved={() => { load(); onChanged?.(); }}
        />
      )}

      {viewingVisit && (
        <VisitDetailModal
          visit={viewingVisit}
          onClose={() => setViewingVisit(null)}
          /* Removing one person from a trip changes this list (and can delete
             the trip outright), so the history has to be reloaded even though
             nothing here initiated it. */
          onChanged={() => { load(); onChanged?.(); }}
          onEdit={(v) => {
            if (v.user_id != null && v.user_id !== userId && !window.confirm("This visit is logged under a different rep's account. Edit it anyway?")) return;
            setViewingVisit(null);
            setEditingVisit(v);
          }}
          onDelete={(v) => { setViewingVisit(null); removeVisit(v); }}
        />
      )}

      {viewingUpcomingVisit && (
        <UpcomingVisitDetailModal
          visit={viewingUpcomingVisit}
          onClose={() => setViewingUpcomingVisit(null)}
          onComplete={(v) => { setViewingUpcomingVisit(null); setEditingVisit(v); }}
          onSnoozed={() => { setViewingUpcomingVisit(null); load(); }}
          onDelete={(v) => { setViewingUpcomingVisit(null); removeVisit(v); }}
        />
      )}

      {/* VisitLogModal expects `visit_id`, not `id` — map our row's `id` to
          it here so editing an existing visit PATCHes instead of creating a
          new one. */}
      {editingVisit && (
        <VisitLogModal
          visit={{ ...editingVisit, visit_id: editingVisit.id }}
          userId={userId}
          onClose={() => setEditingVisit(null)}
          onSaved={() => { load(); onChanged?.(); }}
        />
      )}

      {planningVisit && (
        <PlanVisitModal
          placeId={data.id}
          placeName={data.name}
          userId={userId}
          users={users}
          onClose={() => setPlanningVisit(false)}
          onSaved={() => { load(); onChanged?.(); }}
        />
      )}
    </div>
  );
}
