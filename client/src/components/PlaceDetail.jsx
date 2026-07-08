import React, { useEffect, useState } from 'react';
import { api, navigateUrl, ROLE_TYPE_LABELS } from '../api';
import { TierChip, StatusChip, OutcomeChip, CategoryChip } from './ui/Chip';
import TemperatureDot from './ui/TemperatureDot';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import VisitLogModal from './VisitLogModal';
import PersonModal from './PersonModal';

// One card in the "People here" grid: a person's name/title/role/temperature,
// plus quick call/email links and an Edit button (opens PersonModal).
function PersonCard({ person, onEdit }) {
  return (
    <div className={`contact-card ${person.departed ? 'departed' : ''}`}>
      <div className="tag-list" style={{ justifyContent: 'space-between' }}>
        <span className="contact-name">{person.name}</span>
        {person.is_primary && <span className="badge star">★ Primary</span>}
      </div>
      {person.title && <div className="tiny muted">{person.title}</div>}
      <div className="tag-list">
        {person.role_type && <span className="contact-role">{ROLE_TYPE_LABELS[person.role_type]}</span>}
        {person.relationship_temp && <TemperatureDot temp={person.relationship_temp} />}
        {person.departed && <span className="badge" style={{ background: 'var(--mauve-tint-2)', color: 'var(--mauve)' }}>Departed</span>}
      </div>
      {(person.phone || person.email) && (
        <div className="tiny muted">
          {person.phone}
          {person.phone && person.email ? ' · ' : ''}
          {person.email}
        </div>
      )}
      <div className="contact-actions">
        {person.phone && <a className="btn ghost small" href={`tel:${person.phone}`}>Call</a>}
        {person.email && <a className="btn ghost small" href={`mailto:${person.email}`}>Email</a>}
        <Button variant="ghost" size="small" onClick={() => onEdit(person)}>Edit</Button>
      </div>
    </div>
  );
}

// Slide-in modal: place details + people here + full visit history + "log a
// visit" action. Opened from Places.jsx (clicking a row) or Dashboard.jsx
// (clicking any place-linked row/card).
export default function PlaceDetail({ placeId, onClose, onChanged, onDeleted }) {
  const [data, setData] = useState(null); // GET /api/places/:id response (place + visits + people)
  const [logging, setLogging] = useState(false); // whether the Log Visit modal is open
  // Controls the (Add/Edit) person modal: undefined = closed, null = creating
  // a brand-new person, an object = editing that existing person.
  const [editingPerson, setEditingPerson] = useState(undefined);
  const [deleting, setDeleting] = useState(false);
  // Durable, org-level notes (separate from any single visit's notes or a
  // person's notes) — editable inline via a small textarea + Save.
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);

  async function load() {
    setData(await api.place(placeId));
  }
  useEffect(() => {
    load();
  }, [placeId]);

  // Permanently removes the place along with all of its visits/people
  // (cascaded at the DB level) — confirm since there's no undo.
  async function deletePlace() {
    if (!window.confirm(`Delete ${data.name}? This removes all of its visit history and people and can't be undone.`)) return;
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

  // Show a lightweight loading modal while the initial fetch is in flight.
  if (!data) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="loading">Loading…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      {/* stopPropagation so clicking inside the modal doesn't bubble up to the
          backdrop's onClick (which would close the modal). */}
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{data.name}</h2>
            <div className="tag-list" style={{ marginTop: 4 }}>
              <CategoryChip category={data.category} />
              <TierChip tier={data.tier} isPriority={data.is_priority} />
            </div>
          </div>
          <button className="close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="tiny">
            {data.address && <div>{data.address}</div>}
            <div>{data.city}, {data.state} {data.zip} · <strong>{data.region}</strong></div>
            {data.phone && <div>{data.phone}</div>}
          </div>
          <div className="tag-list">
            <Button variant="secondary" size="small" onClick={() => window.open(navigateUrl(data), '_blank')}>Navigate</Button>
            {/* Call button only shows if this place has a phone number on file
                (not populated from the original Excel import — added manually). */}
            {data.phone && <a className="btn secondary small" href={`tel:${data.phone}`}>Call</a>}
          </div>

          {/* Durable notes about the organization itself — not tied to any one
              visit or person (e.g. "front desk is picky about walk-ins"). */}
          <div className="card">
            <div className="card-head">
              <h2>Notes</h2>
              {!editingNotes && (
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => { setNotesDraft(data.notes || ''); setEditingNotes(true); }}
                >
                  {data.notes ? 'Edit' : 'Add notes'}
                </Button>
              )}
            </div>
            <div className="card-body">
              {editingNotes ? (
                <div className="stack">
                  <textarea rows={3} value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} autoFocus />
                  <div className="tag-list">
                    <Button size="small" onClick={saveNotes} disabled={savingNotes}>
                      {savingNotes ? 'Saving…' : 'Save'}
                    </Button>
                    <Button variant="secondary" size="small" onClick={() => setEditingNotes(false)} disabled={savingNotes}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : data.notes ? (
                <div className="tiny">{data.notes}</div>
              ) : (
                <EmptyState message="No standing notes about this place yet." />
              )}
            </div>
          </div>

          {/* People here: every person recorded at this place. */}
          <div className="card">
            <div className="card-head">
              <h2>People here ({data.people.length})</h2>
              <Button variant="secondary" size="small" onClick={() => setEditingPerson(null)}>Add person</Button>
            </div>
            <div className="card-body">
              {data.people.length === 0 ? (
                <EmptyState message="No one on file here yet. Add the people you meet so the team knows who to ask for." />
              ) : (
                <div className="contact-grid">
                  {data.people.map((p) => (
                    <PersonCard key={p.id} person={p} onEdit={setEditingPerson} />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Referral attribution isn't wired up yet — placeholder for now
              (see the referrals table in the data-model migration). */}
          <div className="card">
            <div className="card-head"><h2>Referrals</h2></div>
            <div className="card-body">
              <EmptyState message="No referrals recorded yet." />
            </div>
          </div>

          {/* Every visit ever logged on this place, most recent first. */}
          <div className="card">
            <div className="card-head"><h2>Visit history ({data.visits.length})</h2></div>
            <div className="card-body">
              {data.visits.length === 0 ? (
                <EmptyState message="No visits logged yet." />
              ) : (
                <ul className="list">
                  {data.visits.map((v) => (
                    <li key={v.id} className="stack" style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
                      <div className="tag-list">
                        <strong className="tiny">{v.scheduled_date || 'unscheduled'}</strong>
                        <StatusChip status={v.status} />
                        <OutcomeChip outcome={v.outcome} />
                        {v.user_name && <span className="tiny muted">· {v.user_name}</span>}
                      </div>
                      {v.notes && <div className="tiny">{v.notes}</div>}
                      {/* This is the free-text "who I talked to on this specific
                          visit" snapshot stored on the visit itself — separate
                          from the durable people list above. */}
                      {(v.person_name || v.person_email || v.person_phone) && (
                        <div className="tiny muted">
                          {[v.person_name, v.person_title].filter(Boolean).join(', ')}
                          {v.person_email ? ` · ${v.person_email}` : ''}
                          {v.person_phone ? ` · ${v.person_phone}` : ''}
                        </div>
                      )}
                      {v.next_visit_date && <div className="tiny muted">Next visit: {v.next_visit_date}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <Button variant="danger" style={{ marginRight: 'auto' }} onClick={deletePlace} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete place'}
          </Button>
          <Button onClick={() => setLogging(true)}>Log a visit</Button>
        </div>
      </div>

      {/* Ad-hoc visit logging — not tied to today's generated route, just this place. */}
      {logging && (
        <VisitLogModal
          placeId={data.id}
          placeName={data.name}
          onClose={() => setLogging(false)}
          onSaved={() => { load(); onChanged?.(); }}
        />
      )}

      {/* Add/Edit person modal — only rendered when editingPerson isn't undefined. */}
      {editingPerson !== undefined && (
        <PersonModal
          placeId={data.id}
          person={editingPerson}
          onClose={() => setEditingPerson(undefined)}
          onSaved={() => { load(); onChanged?.(); }}
        />
      )}
    </div>
  );
}
