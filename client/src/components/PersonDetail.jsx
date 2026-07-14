import React, { useEffect, useState } from 'react';
import { api, ROLE_TYPE_LABELS, formatDate } from '../api';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import PersonModal from './PersonModal';
import ReferralModal from './ReferralModal';
import ReferralDetailModal from './ReferralDetailModal';
import VisitDetailModal from './VisitDetailModal';
import VisitLogModal from './VisitLogModal';

// Slide-in modal: a person's own detail — their place, contact info,
// durable notes/preferences, and every visit where they were the recorded
// contact (their personal "last time we spoke" history). Opened from
// People.jsx (clicking a row).
export default function PersonDetail({ personId, userId, onClose, onChanged, onDeleted, onOpenPlace }) {
  const [data, setData] = useState(null); // GET /api/people/:id response (person + place + visits)
  const [loadError, setLoadError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [places, setPlaces] = useState([]); // every place, for the "assign to a place" picker
  const [removingFromPlace, setRemovingFromPlace] = useState(false);
  const [assigning, setAssigning] = useState(false); // whether the "assign to a place" picker is open
  const [placeDraft, setPlaceDraft] = useState('');
  const [removingReferralId, setRemovingReferralId] = useState(null); // referral currently being deleted (disables its row)
  const [loggingReferral, setLoggingReferral] = useState(false); // whether the Log Referral modal is open
  const [viewingReferral, setViewingReferral] = useState(null); // referral whose full detail popup is open, if any
  const [editingReferral, setEditingReferral] = useState(null); // referral currently open in ReferralModal for editing, if any
  const [removingVisitId, setRemovingVisitId] = useState(null); // visit currently being deleted (disables its row)
  const [viewingVisit, setViewingVisit] = useState(null); // visit whose full detail popup is open, if any
  const [editingVisit, setEditingVisit] = useState(null); // visit currently open in VisitLogModal for editing, if any
  // Durable notes about this person — editable inline via a small textarea +
  // Save, same pattern as PlaceDetail's org-level notes.
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [removingNotes, setRemovingNotes] = useState(false);
  // Preferences and birthday get the same click-to-edit treatment.
  const [editingPreferences, setEditingPreferences] = useState(false);
  const [preferencesDraft, setPreferencesDraft] = useState('');
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [removingPreferences, setRemovingPreferences] = useState(false);
  const [editingBirthday, setEditingBirthday] = useState(false);
  const [birthdayDraft, setBirthdayDraft] = useState('');
  const [savingBirthday, setSavingBirthday] = useState(false);
  const [removingBirthday, setRemovingBirthday] = useState(false);

  async function load() {
    try {
      setLoadError(null);
      setData(await api.people.get(personId));
    } catch (e) {
      setLoadError(e.message);
    }
  }
  useEffect(() => {
    load();
  }, [personId]);
  useEffect(() => {
    api.places({}).then(setPlaces).catch(() => {});
  }, []);

  async function deletePerson() {
    const referralCount = data.referral_metrics.lifetime_referrals;
    const referralWarning = referralCount
      ? ` They're credited with ${referralCount} referral${referralCount === 1 ? '' : 's'} — those will be permanently deleted too, since a referral needs someone to attribute it to.`
      : '';
    if (!window.confirm(`Delete ${data.name}? This can't be undone. Their visit history stays on file.${referralWarning}`)) return;
    setDeleting(true);
    try {
      await api.people.remove(data.id);
      onDeleted?.();
      onClose();
    } catch (e) {
      window.alert(e.message);
      setDeleting(false);
    }
  }

  // Detaches this person from their place (place_id -> null) without
  // deleting them — their visit history stays exactly as it was.
  async function removeFromPlace() {
    if (!window.confirm(`Remove ${data.name} from ${data.place.name}? Their visit history will stay on file — you'll still see it here.`)) return;
    setRemovingFromPlace(true);
    try {
      await api.people.update(data.id, { place_id: null });
      load();
      onChanged?.();
    } catch (e) {
      window.alert(e.message);
    } finally {
      setRemovingFromPlace(false);
    }
  }

  // Shared by the notes/preferences/birthday click-to-edit fields below — same
  // save-one-field / remove-one-field shape for each, differing only in which
  // field and which state setters/confirm text apply.
  async function saveField(field, value, { setEditing, setSaving }) {
    setSaving(true);
    try {
      await api.people.update(data.id, { [field]: value });
      setEditing(false);
      load();
      onChanged?.();
    } catch (e) {
      window.alert(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function removeField(field, confirmText, { setEditing, setRemoving }) {
    if (!window.confirm(confirmText)) return;
    setRemoving(true);
    try {
      await api.people.update(data.id, { [field]: null });
      setEditing(false);
      load();
      onChanged?.();
    } catch (e) {
      window.alert(e.message);
    } finally {
      setRemoving(false);
    }
  }

  const saveNotes = () => saveField('notes', notesDraft, { setEditing: setEditingNotes, setSaving: setSavingNotes });
  const removeNotes = () =>
    removeField('notes', "Remove this note? This can't be undone.", { setEditing: setEditingNotes, setRemoving: setRemovingNotes });

  const savePreferences = () =>
    saveField('preferences', preferencesDraft, { setEditing: setEditingPreferences, setSaving: setSavingPreferences });
  const removePreferences = () =>
    removeField('preferences', "Remove these preferences? This can't be undone.", { setEditing: setEditingPreferences, setRemoving: setRemovingPreferences });

  const saveBirthday = () =>
    saveField('birthday', birthdayDraft, { setEditing: setEditingBirthday, setSaving: setSavingBirthday });
  const removeBirthday = () =>
    removeField('birthday', "Remove this birthday? This can't be undone.", { setEditing: setEditingBirthday, setRemoving: setRemovingBirthday });

  // The Notes card packs three independently-editable fields into one place;
  // opening one should back out of whichever of the other two is mid-edit
  // (and the place picker, if that's open) rather than leaving multiple
  // drafts open at once.
  function beginEditNotes(value) {
    setNotesDraft(value);
    setEditingNotes(true);
    setEditingPreferences(false);
    setEditingBirthday(false);
    setAssigning(false);
  }
  function beginEditPreferences(value) {
    setPreferencesDraft(value);
    setEditingPreferences(true);
    setEditingNotes(false);
    setEditingBirthday(false);
    setAssigning(false);
  }
  function beginEditBirthday(value) {
    setBirthdayDraft(value);
    setEditingBirthday(true);
    setEditingNotes(false);
    setEditingPreferences(false);
    setAssigning(false);
  }

  // Any other action taken on this card — assigning a place, logging or
  // viewing a referral/visit, editing the person — should back out of
  // whichever notes/preferences/birthday field is mid-edit, same as a
  // backdrop click does (see handleBackdropClick below).
  function exitFieldEdits() {
    setEditingNotes(false);
    setEditingPreferences(false);
    setEditingBirthday(false);
  }

  async function assignToPlace() {
    if (!placeDraft) return;
    try {
      await api.people.update(data.id, { place_id: placeDraft });
      setAssigning(false);
      setPlaceDraft('');
      load();
      onChanged?.();
    } catch (e) {
      window.alert(e.message);
    }
  }

  // Deletes a mis-logged referral entirely (referrals don't have a "keep the
  // history" concept the way visits/people do).
  async function removeReferral(referral) {
    if (!window.confirm("Delete this referral? This can't be undone.")) return;
    setRemovingReferralId(referral.id);
    try {
      await api.referrals.remove(referral.id);
      load();
      onChanged?.();
    } catch (e) {
      window.alert(e.message);
    } finally {
      setRemovingReferralId(null);
    }
  }

  // Deletes a visit entirely — it's the same underlying row PlaceDetail
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

  // Clicking the backdrop backs out of whatever's actively being edited
  // (the place picker, or an inline notes/preferences/birthday edit) instead
  // of closing the whole card out from under an in-progress edit — a second
  // backdrop click (with nothing left open) closes the card as normal.
  // stopPropagation matters here too: this card can itself be nested inside
  // PlaceDetail's own backdrop (opened by clicking a person row there), so
  // without it, closing this card would bubble up and close PlaceDetail too.
  function handleBackdropClick(e) {
    e.stopPropagation();
    if (assigning || editingNotes || editingPreferences || editingBirthday) {
      setAssigning(false);
      setPlaceDraft('');
      setEditingNotes(false);
      setEditingPreferences(false);
      setEditingBirthday(false);
    } else {
      onClose();
    }
  }

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

  const { referral_metrics: metrics } = data;

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="tag-list" style={{ alignItems: 'center' }}>
              <h2 style={{ fontSize: 22 }}>{data.name}</h2>
              {data.role_type && <span className="badge role">{ROLE_TYPE_LABELS[data.role_type]}</span>}
              <span className="badge" style={{ background: 'var(--teal-tint-2)', color: 'var(--teal-dark)' }}>
                {metrics.lifetime_referrals} referral{metrics.lifetime_referrals === 1 ? '' : 's'}
              </span>
              {metrics.needs_attention && (
                <span className="badge attention" title="Referred before, but nothing in the last 90 days">
                  Cooling — needs attention
                </span>
              )}
            </div>
            {data.title && <div className="tiny muted" style={{ marginTop: 4 }}>{data.title}</div>}
          </div>
          <button className="close" title="Close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {loadError && <div className="error-banner">{loadError}</div>}
          {(data.phone || data.email) && (
            <div className="stack" style={{ background: 'var(--bg)', borderRadius: 'var(--radius-md)', padding: '12px 16px' }}>
              <div className="tiny">
                {data.phone && <div>{data.phone}</div>}
                {data.email && <div>{data.email}</div>}
              </div>
              <div className="tag-list">
                {data.phone && <a className="btn secondary small" title={`Call ${data.phone}`} href={`tel:${data.phone}`}>Call</a>}
                {data.email && <a className="btn secondary small" title={`Email ${data.email}`} href={`mailto:${data.email}`}>Email</a>}
              </div>
            </div>
          )}

          {/* Which place they belong to — or, since a person doesn't have to
              be tied to one, a way to assign them to one. */}
          <div className="card">
            <div className="card-head"><h2>Place</h2></div>
            <div className="card-body">
              {data.place ? (
                <div
                  className="hover-row"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}
                  title="Open this person's place"
                  onClick={() => onOpenPlace?.(data.place.id)}
                >
                  <div>
                    <strong>{data.place.name}</strong>
                    <div className="tiny muted">{data.place.city}, {data.place.state} {data.place.zip}</div>
                  </div>
                  <Button
                    variant="ghost"
                    size="small"
                    title="Unassign from this place — they stay on file, just no longer linked here"
                    disabled={removingFromPlace}
                    onClick={(e) => { e.stopPropagation(); removeFromPlace(); }}
                  >
                    ✕
                  </Button>
                </div>
              ) : assigning ? (
                <div className="row" style={{ alignItems: 'center' }}>
                  <select value={placeDraft} onChange={(e) => setPlaceDraft(e.target.value)} autoFocus>
                    <option value="">Select a place…</option>
                    {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <div className="tag-list" style={{ flex: 'unset' }}>
                    <Button size="small" title="Link this person to the selected place" onClick={assignToPlace} disabled={!placeDraft}>Save</Button>
                    <Button variant="secondary" size="small" title="Close without assigning" onClick={() => { setAssigning(false); setPlaceDraft(''); }}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="row" style={{ alignItems: 'center' }}>
                  <EmptyState message="Not currently assigned to a place." />
                  <Button variant="secondary" size="small" title="Link this person to a place" onClick={() => { exitFieldEdits(); setAssigning(true); }}>Assign to a place</Button>
                </div>
              )}
            </div>
          </div>

          {/* Durable notes/preferences about this person — persist across visits. */}
          <div className="card">
            <div className="card-head">
              <h2>Notes</h2>
              <div className="tag-list" style={{ flex: 'unset' }}>
                {!data.preferences && !editingPreferences && (
                  <Button
                    variant="secondary"
                    size="small"
                    title="Add preferences for this person"
                    onClick={() => beginEditPreferences('')}
                  >
                    Add preferences
                  </Button>
                )}
                {!data.birthday && !editingBirthday && (
                  <Button
                    variant="secondary"
                    size="small"
                    title="Add this person's birthday"
                    onClick={() => beginEditBirthday('')}
                  >
                    Add birthday
                  </Button>
                )}
                {!data.notes && !editingNotes && (
                  <Button
                    variant="secondary"
                    size="small"
                    title="Add a standing note about this person"
                    onClick={() => beginEditNotes('')}
                  >
                    Add notes
                  </Button>
                )}
              </div>
            </div>
            <div className="card-body stack">
              {editingPreferences ? (
                <div className="stack">
                  <textarea
                    rows={3}
                    value={preferencesDraft}
                    onChange={(e) => setPreferencesDraft(e.target.value)}
                    placeholder="Coffee order, how they like to be reached…"
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); savePreferences(); } }}
                    autoFocus
                  />
                  <div className="tag-list" style={{ justifyContent: 'space-between' }}>
                    {data.preferences ? (
                      <Button variant="danger" size="small" title="Delete preferences — can't be undone" onClick={removePreferences} disabled={removingPreferences || savingPreferences}>
                        {removingPreferences ? 'Deleting…' : 'Delete'}
                      </Button>
                    ) : <span />}
                    <div className="tag-list">
                      <Button variant="secondary" size="small" title="Discard without saving" onClick={() => setEditingPreferences(false)} disabled={savingPreferences || removingPreferences}>
                        Cancel
                      </Button>
                      <Button size="small" title="Save preferences" onClick={savePreferences} disabled={savingPreferences || removingPreferences}>
                        {savingPreferences ? 'Saving…' : 'Save'}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : data.preferences ? (
                <div className="tiny hover-row" title="Click to edit" onClick={() => beginEditPreferences(data.preferences || '')}>
                  <strong>Preferences:</strong> {data.preferences}
                </div>
              ) : null}

              {editingBirthday ? (
                <div className="stack">
                  <input
                    value={birthdayDraft}
                    onChange={(e) => setBirthdayDraft(e.target.value)}
                    placeholder="e.g. March 14"
                    style={{ maxWidth: 200 }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveBirthday(); } }}
                    autoFocus
                  />
                  <div className="tag-list" style={{ justifyContent: 'space-between' }}>
                    {data.birthday ? (
                      <Button variant="danger" size="small" title="Delete birthday — can't be undone" onClick={removeBirthday} disabled={removingBirthday || savingBirthday}>
                        {removingBirthday ? 'Deleting…' : 'Delete'}
                      </Button>
                    ) : <span />}
                    <div className="tag-list">
                      <Button variant="secondary" size="small" title="Discard without saving" onClick={() => setEditingBirthday(false)} disabled={savingBirthday || removingBirthday}>
                        Cancel
                      </Button>
                      <Button size="small" title="Save birthday" onClick={saveBirthday} disabled={savingBirthday || removingBirthday}>
                        {savingBirthday ? 'Saving…' : 'Save'}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : data.birthday ? (
                <div className="tiny hover-row" title="Click to edit" onClick={() => beginEditBirthday(data.birthday || '')}>
                  <strong>Birthday:</strong> {data.birthday}
                </div>
              ) : null}

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
                <div className="tiny hover-row" title="Click to edit" onClick={() => beginEditNotes(data.notes || '')}>
                  {data.notes}
                </div>
              ) : (
                !data.preferences && !data.birthday && !editingPreferences && !editingBirthday && (
                  <EmptyState message="No notes on file for this person yet." />
                )
              )}
            </div>
          </div>

          {/* Every referral this person has sent us, most recent first, plus
              the three headline metrics computed live from that list (see
              services/referralMetrics.js) — no manual "temperature" to set. */}
          <div className="card">
            <div className="card-head">
              <h2>Referrals ({metrics.lifetime_referrals})</h2>
              <Button size="small" title="Record a new referral from this person" onClick={() => { exitFieldEdits(); setLoggingReferral(true); }}>Log a referral</Button>
            </div>
            <div className="card-body stack">
              <div className="tiny muted">
                Last referral: {metrics.last_referral_date ? formatDate(metrics.last_referral_date) : 'none yet'} · {metrics.referrals_last_90_days} in the last 90 days
              </div>
              {metrics.needs_attention && (
                <div className="tiny" style={{ color: 'var(--mauve)' }}>
                  Cooling — referred before, but nothing in the last 90 days.
                </div>
              )}
              {data.referrals.length === 0 ? (
                <EmptyState message="No referrals logged for this person yet." />
              ) : (
                <ul className="list">
                  {data.referrals.map((r) => (
                    <li
                      key={r.id}
                      className="stack hover-row"
                      style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}
                      onClick={() => { exitFieldEdits(); setViewingReferral(r); }}
                    >
                      <div className="tag-list" style={{ justifyContent: 'space-between' }}>
                        <strong className="tiny">{r.referral_date ? formatDate(r.referral_date) : 'no date'}</strong>
                        <Button
                          variant="danger"
                          size="small"
                          title="Delete this referral"
                          disabled={removingReferralId === r.id}
                          onClick={(e) => { e.stopPropagation(); removeReferral(r); }}
                        >
                          ✕
                        </Button>
                      </div>
                      {r.notes && <div className="tiny">{r.notes}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Every visit where this person was the recorded contact, most
              recent first — the "last time we spoke with them" history. This
              survives even if the place it happened at is later deleted or
              this person is moved to a different place. */}
          <div className="card">
            <div className="card-head"><h2>Visit history ({data.visits.length})</h2></div>
            <div className="card-body">
              {data.visits.length === 0 ? (
                <EmptyState message="No visits logged with this person yet." />
              ) : (
                <ul className="list">
                  {data.visits.map((v) => (
                    <li
                      key={v.id}
                      className="stack hover-row"
                      style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}
                      onClick={() => { exitFieldEdits(); setViewingVisit(v); }}
                    >
                      <div className="tag-list" style={{ justifyContent: 'space-between' }}>
                        <div className="tag-list" style={{ flex: 'unset' }}>
                          <strong className="tiny">{v.scheduled_date ? formatDate(v.scheduled_date) : 'unscheduled'}</strong>
                          {/* "Bede Fulton at Guardian Angels (Test)" — who visited, then where. */}
                          {(v.user_name || v.place_name) && (
                            <span className="tiny muted">
                              · {[v.user_name, v.place_name && `at ${v.place_name}`].filter(Boolean).join(' ')}
                            </span>
                          )}
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
            title="Permanently delete this person — can't be undone. Their visit history stays on file (no longer linked to them), but their referrals are deleted along with them."
            onClick={deletePerson}
            disabled={deleting}
          >
            {deleting ? 'Deleting…' : 'Delete person'}
          </Button>
          <Button variant="secondary" title="Edit this person's details" onClick={() => { exitFieldEdits(); setEditing(true); }}>Edit</Button>
        </div>
      </div>

      {editing && (
        <PersonModal
          placeId={data.place_id}
          person={data}
          onClose={() => setEditing(false)}
          onSaved={() => { load(); onChanged?.(); }}
        />
      )}

      {loggingReferral && (
        <ReferralModal
          person={{ id: data.id, name: data.name }}
          onClose={() => setLoggingReferral(false)}
          onSaved={() => { load(); onChanged?.(); }}
        />
      )}

      {viewingReferral && (
        <ReferralDetailModal
          referral={viewingReferral}
          onClose={() => setViewingReferral(null)}
          onEdit={(r) => { setViewingReferral(null); setEditingReferral(r); }}
          onDelete={(r) => { setViewingReferral(null); removeReferral(r); }}
        />
      )}

      {editingReferral && (
        <ReferralModal
          referral={editingReferral}
          person={{ id: data.id, name: data.name }}
          onClose={() => setEditingReferral(null)}
          onSaved={() => { load(); onChanged?.(); }}
        />
      )}

      {viewingVisit && (
        <VisitDetailModal
          visit={viewingVisit}
          onClose={() => setViewingVisit(null)}
          onEdit={(v) => { setViewingVisit(null); setEditingVisit(v); }}
          onDelete={(v) => { setViewingVisit(null); removeVisit(v); }}
        />
      )}

      {/* VisitLogModal expects `visit_id` (it doubles as Schedule.jsx's stop
          editor, where visits come shaped that way) — map our row's `id` to
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
