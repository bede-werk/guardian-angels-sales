import React, { useEffect, useState } from 'react';
import { api, navigateUrl, formatDate } from '../api';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import VisitLogModal from './VisitLogModal';
import PersonModal from './PersonModal';
import PlaceModal from './PlaceModal';
import AssignPersonModal from './AssignPersonModal';
import PersonDetail from './PersonDetail';
import ReferralModal from './ReferralModal';
import VisitDetailModal from './VisitDetailModal';

// Slide-in modal: place details + people here + full visit history + "log a
// visit" action. Opened from Places.jsx (clicking a row) or Dashboard.jsx
// (clicking any place-linked row/card).
export default function PlaceDetail({ placeId, onClose, onChanged, onDeleted }) {
  const [data, setData] = useState(null); // GET /api/places/:id response (place + visits + people)
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
  const [editingVisit, setEditingVisit] = useState(null); // visit currently open in VisitLogModal for editing, if any
  // Durable, org-level notes (separate from any single visit's notes or a
  // person's notes) — editable inline via a small textarea + Save.
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [removingNotes, setRemovingNotes] = useState(false);

  async function load() {
    setData(await api.place(placeId));
  }
  useEffect(() => {
    load();
  }, [placeId]);
  useEffect(() => {
    api.filters().then((f) => setCategories(f.categories)).catch(() => {});
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

  // Deletes a visit entirely — it's the same underlying row PersonDetail
  // reads too, so removing it here also removes it there on next load.
  async function removeVisit(visit) {
    if (!window.confirm("Delete this visit? This can't be undone.")) return;
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
          <div className="loading">Loading…</div>
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
              {data.referral_metrics.needs_attention && (
                <span className="badge attention" title="Referred before, but nothing in the last 90 days">
                  Cooling — needs attention
                </span>
              )}
            </div>
          </div>
          <button className="close" title="Close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="stack" style={{ background: 'var(--bg)', borderRadius: 'var(--radius-md)', padding: '12px 16px' }}>
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

          {/* Durable notes about the organization itself — not tied to any one
              visit or person (e.g. "front desk is picky about walk-ins"). */}
          <div className="card">
            <div className="card-head">
              <h2>Notes</h2>
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
            <div className="card-body">
              {editingNotes ? (
                <div className="stack">
                  <textarea
                    rows={3}
                    value={notesDraft}
                    onChange={(e) => setNotesDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNotes(); } }}
                    autoFocus
                  />
                  <div className="tag-list">
                    <Button size="small" title="Save this note" onClick={saveNotes} disabled={savingNotes}>
                      {savingNotes ? 'Saving…' : 'Save'}
                    </Button>
                    {data.notes ? (
                      <Button variant="danger" size="small" title="Delete this note — can't be undone" onClick={removeNotes} disabled={removingNotes || savingNotes}>
                        {removingNotes ? 'Removing…' : 'Remove'}
                      </Button>
                    ) : (
                      <Button variant="secondary" size="small" title="Discard without saving" onClick={() => setEditingNotes(false)} disabled={savingNotes}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>
              ) : data.notes ? (
                <div className="tiny hover-row" title="Click to edit" onClick={() => { setNotesDraft(data.notes || ''); setEditingNotes(true); }}>
                  {data.notes}
                </div>
              ) : (
                <EmptyState message="No standing notes about this place yet." />
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
                <Button variant="secondary" size="small" title="Link an existing person on file to this place" onClick={() => setAssigningPerson(true)}>Assign person</Button>
                <Button variant="secondary" size="small" title="Create a brand-new person here" onClick={() => setEditingPerson(null)}>New person</Button>
                <Button size="small" title="Record a referral from someone at this place" onClick={() => setLoggingReferral(true)}>Log a referral</Button>
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
                      className={`stop hover-row ${p.departed ? 'skipped' : ''}`}
                      style={{ justifyContent: 'space-between' }}
                      onClick={() => setSelectedPersonId(p.id)}
                    >
                      <div className="main">
                        <div className="name">{p.name}</div>
                        {p.title && <div className="meta">{p.title}</div>}
                      </div>
                      <div className="tag-list" style={{ flex: 'unset' }}>
                        {p.is_primary && <span className="badge star">★</span>}
                        {p.departed && <span className="badge" style={{ background: 'var(--mauve-tint-2)', color: 'var(--mauve)' }}>Departed</span>}
                        <span className="tiny muted">
                          {p.referral_metrics.lifetime_referrals} referral{p.referral_metrics.lifetime_referrals === 1 ? '' : 's'}
                          {p.referral_metrics.last_referral_date ? ` · last ${formatDate(p.referral_metrics.last_referral_date)}` : ''}
                        </span>
                        {p.referral_metrics.needs_attention && (
                          <span className="badge attention" title="Referred before, but nothing in the last 90 days">
                            Cooling
                          </span>
                        )}
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

          {/* Every visit ever logged on this place, most recent first. */}
          <div className="card">
            <div className="card-head">
              <h2>Visit history ({data.visits.length})</h2>
              <Button size="small" title="Record a visit to this place" onClick={() => setLogging(true)}>Log a visit</Button>
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
                      onClick={() => setViewingVisit(v)}
                    >
                      <div className="tag-list" style={{ justifyContent: 'space-between' }}>
                        <div className="tag-list" style={{ flex: 'unset' }}>
                          <strong className="tiny">{v.scheduled_date ? formatDate(v.scheduled_date) : 'unscheduled'}</strong>
                          {v.person_name && <span className="tiny muted">· with {v.person_name}</span>}
                        </div>
                        <Button
                          variant="danger"
                          size="small"
                          title="Delete this visit"
                          disabled={removingVisitId === v.id}
                          onClick={(e) => { e.stopPropagation(); removeVisit(v); }}
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
          <Button variant="secondary" title="Edit this place's details" onClick={() => setEditing(true)}>Edit</Button>
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
          onEdit={(v) => { setViewingVisit(null); setEditingVisit(v); }}
        />
      )}

      {/* VisitLogModal expects `visit_id` (it doubles as Schedule.jsx's stop
          editor, where visits come shaped that way) — map our row's `id` to
          it here so editing an existing visit PATCHes instead of creating a
          new one. */}
      {editingVisit && (
        <VisitLogModal
          visit={{ ...editingVisit, visit_id: editingVisit.id }}
          onClose={() => setEditingVisit(null)}
          onSaved={() => { load(); onChanged?.(); }}
        />
      )}
    </div>
  );
}
