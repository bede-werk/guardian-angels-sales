import React, { useEffect, useState } from 'react';
import { api, navigateUrl, formatDate, VISIT_TYPE_LABELS } from '../api';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import VisitLogModal from './VisitLogModal';
import PersonModal from './PersonModal';
import PlaceModal from './PlaceModal';
import AssignPersonModal from './AssignPersonModal';
import PersonDetail from './PersonDetail';
import ReferralModal from './ReferralModal';
import VisitDetailModal, { encounterLabel, joinNames } from './VisitDetailModal';
import UpcomingVisitDetailModal from './UpcomingVisitDetailModal';
import { PlaceRelationship } from './RelationshipDetail';

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

// Slide-in modal: place details + people here + full visit history + "log a
// visit" action. Opened from Places.jsx (clicking a row) or Dashboard.jsx
// (clicking any place-linked row/card).
export default function PlaceDetail({ placeId, userId, onClose, onChanged, onDeleted }) {
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
  // Pre-qualification: capacity_monthly_referrals ("real number captured at
  // pre-qual") + capacity_status (estimated | adjusted | verified) — same
  // click-to-edit pattern as notes above, editable directly here even though
  // it's normally captured once via VisitLogModal's first-visit field.
  const [editingPreQual, setEditingPreQual] = useState(false);
  const [preQualDraft, setPreQualDraft] = useState('');
  const [savingPreQual, setSavingPreQual] = useState(false);
  const [removingPreQual, setRemovingPreQual] = useState(false);
  // Manual relationship override (see RelationshipDetail.jsx). The editor's
  // own open/closed state lives in that component; only the in-flight save
  // needs to be known here, since this is what triggers the reload.
  const [savingRelationship, setSavingRelationship] = useState(false);

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
      onClose();
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

  // Editing directly here (as opposed to VisitLogModal's first-visit field,
  // which sets capacity_status: 'verified') lands as 'adjusted' — a
  // corrected estimate, not a fresh pre-qualification conversation.
  async function savePreQual() {
    setSavingPreQual(true);
    try {
      // Rounded client-side — capacity_monthly_referrals is a real DB integer
      // column, and the server silently drops (doesn't error on) a
      // non-integer value rather than rejecting the save outright.
      const rounded = Math.max(0, Math.round(Number(preQualDraft)));
      await api.updatePlace(data.id, { capacity_monthly_referrals: rounded, capacity_status: 'adjusted' });
      setEditingPreQual(false);
      load();
      onChanged?.();
    } catch (e) {
      window.alert(e.message);
    } finally {
      setSavingPreQual(false);
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

  async function removePreQual() {
    if (!window.confirm("Clear this place's pre-qualification estimate? This can't be undone.")) return;
    setRemovingPreQual(true);
    try {
      await api.updatePlace(data.id, { capacity_monthly_referrals: null, capacity_status: 'estimated' });
      setEditingPreQual(false);
      load();
      onChanged?.();
    } catch (e) {
      window.alert(e.message);
    } finally {
      setRemovingPreQual(false);
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
  async function removeVisit(visit) {
    if (!window.confirm("Delete this visit? Everyone recorded on it goes with it. This can't be undone.")) return;
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
      <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          {loadError ? (
            <div className="stack" style={{ padding: 20 }}>
              <div className="error-banner">{loadError}</div>
              <Button variant="secondary" onClick={onClose}>Close</Button>
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
    } else if (editingPreQual) {
      setEditingPreQual(false);
    } else {
      onClose();
    }
  }

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      {/* stopPropagation so clicking inside the modal doesn't bubble up to the
          backdrop's onClick (which would close the modal). */}
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="tag-list" style={{ alignItems: 'center' }}>
              <h2 style={{ fontSize: 22 }}>{data.name}</h2>
              <span className="badge" style={{ background: 'var(--teal-tint-2)', color: 'var(--teal-dark)' }}>
                {data.referral_metrics.lifetime_referrals} referral{data.referral_metrics.lifetime_referrals === 1 ? '' : 's'}
              </span>
            </div>
          </div>
          <button className="close" title="Close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {loadError && <div className="error-banner">{loadError}</div>}
          {/* Address/contact on the left, relationship status on the right —
              two half-width cards side by side rather than one full-width
              block stacked above the other. */}
          <div style={{ display: 'flex', gap: 14, alignItems: 'stretch' }}>
            <div className="card" style={{ flex: 1, minWidth: 0 }}>
              <div className="card-head"><h2>Contact Info</h2></div>
              <div className="card-body stack">
                <div className="tiny">
                  {data.address && <div>{data.address}</div>}
                  <div>{data.city}, {data.state} {data.zip} · <strong>{data.region}</strong></div>
                  {data.phone && <div>{data.phone}</div>}
                </div>
                <div className="tag-list">
                  <Button variant="secondary" size="small" title="Open directions to this address in Google Maps" onClick={() => window.open(navigateUrl(data), '_blank')}>Navigate</Button>
                  {/* Call button only shows if this place has a phone number on file
                      (not populated from the original Excel import — added manually). */}
                  {data.phone && <a className="btn secondary small" title={`Call ${data.phone}`} href={`tel:${data.phone}`}>Call</a>}
                </div>
              </div>
            </div>
            <div className="card" style={{ flex: 1, minWidth: 0 }}>
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

          {/* Durable notes about the organization itself — not tied to any one
              visit or person (e.g. "front desk is picky about walk-ins").
              Pre-qualification (capacity_monthly_referrals/capacity_status —
              see routes/places.js) lives in this same card as one compact
              line, same add-then-click-to-edit interaction as notes below:
              nothing set yet -> small muted "Needs pre-qualification" text
              (not clickable) + an "Add pre-qualification" button up in the
              card-head next to "Add notes"; once set -> the button's gone
              and the line itself ("Pre-qualified · ~N referrals/month")
              becomes the click-to-edit target, same as notes' own text once
              it has a value. 'estimated' (default, seeded from category) vs
              'adjusted' (edited here) vs 'verified' (captured via
              VisitLogModal's first-visit field) collapse to the same two
              labels — the distinction underneath is internal bookkeeping,
              also feeds the route planner's ranking engine (a place stuck at
              'estimated' stays in the "exploration" tier forever). */}
          <div className="card">
            <div className="card-head">
              <h2>Details</h2>
              <div className="tag-list" style={{ flex: 'unset' }}>
                {data.capacity_status === 'estimated' && !editingPreQual && (
                  <Button
                    variant="secondary"
                    size="small"
                    title="Record this place's pre-qualification estimate"
                    onClick={() => { setEditingNotes(false); setPreQualDraft(''); setEditingPreQual(true); }}
                  >
                    Add pre-qualification
                  </Button>
                )}
                {!data.notes && !editingNotes && (
                  <Button
                    variant="secondary"
                    size="small"
                    title="Add a standing note about this place"
                    onClick={() => { setEditingPreQual(false); setNotesDraft(''); setEditingNotes(true); }}
                  >
                    Add notes
                  </Button>
                )}
              </div>
            </div>
            <div className="card-body stack">
              {editingPreQual ? (
                <div className="tag-list" style={{ alignItems: 'center' }}>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="Referrals/month"
                    style={{ width: 120 }}
                    value={preQualDraft}
                    onChange={(e) => setPreQualDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); savePreQual(); } }}
                    autoFocus
                  />
                  <Button size="small" title="Save this estimate" onClick={savePreQual} disabled={savingPreQual || removingPreQual || preQualDraft === ''}>
                    {savingPreQual ? 'Saving…' : 'Save'}
                  </Button>
                  <Button variant="secondary" size="small" title="Discard without saving" onClick={() => setEditingPreQual(false)} disabled={savingPreQual || removingPreQual}>
                    Cancel
                  </Button>
                  {data.capacity_status !== 'estimated' && (
                    <Button variant="danger" size="small" title="Clear this estimate — reverts to needing pre-qualification, can't be undone" onClick={removePreQual} disabled={removingPreQual || savingPreQual}>
                      {removingPreQual ? 'Deleting…' : 'Delete'}
                    </Button>
                  )}
                </div>
              ) : data.capacity_status !== 'estimated' ? (
                <div
                  className="tiny hover-row"
                  title="Click to edit this place's pre-qualification estimate"
                  onClick={() => { setEditingNotes(false); setPreQualDraft(data.capacity_monthly_referrals ?? ''); setEditingPreQual(true); }}
                >
                  Pre-qualified{data.capacity_monthly_referrals != null ? ` · ~${data.capacity_monthly_referrals} referral${data.capacity_monthly_referrals === 1 ? '' : 's'}/month` : ''}
                </div>
              ) : (
                <div className="tiny muted">Needs pre-qualification</div>
              )}

              {editingNotes ? (
                <div className="stack">
                  <textarea
                    rows={3}
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
                <div className="tiny hover-row" title="Click to edit" onClick={() => { setEditingPreQual(false); setNotesDraft(data.notes || ''); setEditingNotes(true); }}>
                  {data.notes}
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

          {/* People here: names, click one to open their full detail
              (PersonDetail) — each person's own referral metrics show in
              their row (the per-person breakdown); the place-level roll-up
              lives up top next to the category/tier badges, and again below
              as a one-line summary since it's important place-level info. */}
          <div className="card">
            <div className="card-head">
              <h2>People ({data.people.length})</h2>
              <div className="tag-list" style={{ flex: 'unset' }}>
                <Button variant="secondary" size="small" title="Link an existing person on file to this place" onClick={() => { setEditingNotes(false); setEditingPreQual(false); setAssigningPerson(true); }}>Assign person</Button>
                <Button variant="secondary" size="small" title="Create a brand-new person here" onClick={() => { setEditingNotes(false); setEditingPreQual(false); setEditingPerson(null); }}>New person</Button>
                <Button size="small" title="Record a referral from someone at this place" onClick={() => { setEditingNotes(false); setEditingPreQual(false); setLoggingReferral(true); }}>Log a referral</Button>
              </div>
            </div>
            <div className="card-body stack">
              <div className="tiny muted">
                Last referral: {data.referral_metrics.last_referral_date ? formatDate(data.referral_metrics.last_referral_date) : 'none yet'} · {data.referral_metrics.referrals_last_90_days} in the last 90 days
              </div>
              {data.people.length === 0 ? (
                <EmptyState message="No one on file here yet. Add the people you meet so the team knows who to ask for." />
              ) : (
                <ul className="list">
                  {data.people.map((p) => (
                    <li
                      key={p.id}
                      className="stop hover-row"
                      style={{ justifyContent: 'space-between' }}
                      onClick={() => { setEditingNotes(false); setEditingPreQual(false); setSelectedPersonId(p.id); }}
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

          {/* Still-open route-planner-committed visits, soonest first. View
              only for now — editing a planned visit will come later, through
              the same Route Planner/schedule-drafts flow a route's own days
              already use, not this card. */}
          <div className="card">
            <div className="card-head">
              <h2>Upcoming visits ({data.upcoming_visits.length})</h2>
            </div>
            <div className="card-body">
              {data.upcoming_visits.length === 0 ? (
                <EmptyState message="Nothing upcoming at this place." />
              ) : (
                <ul className="list">
                  {data.upcoming_visits.map((v) => (
                    <li
                      key={v.id}
                      className="stack hover-row"
                      style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}
                      onClick={() => { setEditingNotes(false); setEditingPreQual(false); setViewingUpcomingVisit(v); }}
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
              each person can be opened on their own. */}
          <div className="card">
            <div className="card-head">
              <h2>Visit history ({data.visits.length})</h2>
              <Button size="small" title="Record a visit to this place" onClick={() => { setEditingNotes(false); setEditingPreQual(false); setLogging(true); }}>Log a visit</Button>
            </div>
            <div className="card-body">
              {data.visits.length === 0 ? (
                <EmptyState message="No visits logged yet." />
              ) : (
                <ul className="list">
                  {data.visits.map((v) => (
                    <li
                      key={v.id}
                      className="stack hover-row"
                      style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}
                      onClick={() => { setEditingNotes(false); setEditingPreQual(false); setViewingVisit(v); }}
                    >
                      {/* nowrap + minWidth:0 so a long "with A, B and C" line
                          wraps within its own column instead of pushing the
                          delete button onto a line of its own. */}
                      <div className="tag-list" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
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
                      </div>
                      {v.notes && <div className="tiny">{v.notes}</div>}
                      {v.next_visit_date && <div className="tiny muted">Next visit: {formatDate(v.next_visit_date)}</div>}
                    </li>
                  ))}
                </ul>
              )}
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
          <Button variant="secondary" title="Edit this place's details" onClick={() => { setEditingNotes(false); setEditingPreQual(false); setEditing(true); }}>Edit</Button>
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
    </div>
  );
}
