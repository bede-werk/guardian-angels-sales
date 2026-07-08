import React, { useEffect, useState } from 'react';
import { api, ROLE_TYPE_LABELS } from '../api';
import { StatusChip, OutcomeChip, CategoryChip, TierChip } from './ui/Chip';
import TemperatureDot from './ui/TemperatureDot';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import PersonModal from './PersonModal';

// Slide-in modal: a person's own detail — their place, contact info,
// durable notes/preferences, and every visit where they were the recorded
// contact (their personal "last time we spoke" history). Opened from
// People.jsx (clicking a row).
export default function PersonDetail({ personId, onClose, onChanged, onDeleted, onOpenPlace }) {
  const [data, setData] = useState(null); // GET /api/people/:id response (person + place + visits)
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function load() {
    setData(await api.people.get(personId));
  }
  useEffect(() => {
    load();
  }, [personId]);

  async function deletePerson() {
    if (!window.confirm(`Delete ${data.name}? This can't be undone.`)) return;
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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{data.name}</h2>
            <div className="tag-list" style={{ marginTop: 4 }}>
              {data.title && <span className="tiny muted">{data.title}</span>}
              {data.role_type && <span className="contact-role">{ROLE_TYPE_LABELS[data.role_type]}</span>}
              {data.relationship_temp && <TemperatureDot temp={data.relationship_temp} />}
              {data.is_primary && <span className="badge star">★ Primary</span>}
              {data.departed && <span className="badge" style={{ background: 'var(--mauve-tint-2)', color: 'var(--mauve)' }}>Departed</span>}
            </div>
          </div>
          <button className="close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {/* Which place they belong to — the "see the place a person is at"
              requirement, with a jump-over link. */}
          {data.place && (
            <div className="card">
              <div className="card-body">
                <div className="row" style={{ alignItems: 'center' }}>
                  <div>
                    <div className="tag-list">
                      <strong>{data.place.name}</strong>
                      <CategoryChip category={data.place.category} />
                      <TierChip tier={data.place.tier} isPriority={data.place.is_priority} />
                    </div>
                    <div className="tiny muted">{data.place.city}, {data.place.state} {data.place.zip}</div>
                  </div>
                  <Button variant="secondary" size="small" onClick={() => onOpenPlace?.(data.place.id)}>View place</Button>
                </div>
              </div>
            </div>
          )}

          {(data.phone || data.email) && (
            <div className="tiny">
              {data.phone && <div>{data.phone}</div>}
              {data.email && <div>{data.email}</div>}
            </div>
          )}
          <div className="tag-list">
            {data.phone && <a className="btn secondary small" href={`tel:${data.phone}`}>Call</a>}
            {data.email && <a className="btn secondary small" href={`mailto:${data.email}`}>Email</a>}
          </div>

          {/* Durable notes/preferences about this person — persist across visits. */}
          <div className="card">
            <div className="card-head"><h2>Notes</h2></div>
            <div className="card-body stack">
              {data.preferences && <div className="tiny"><strong>Preferences:</strong> {data.preferences}</div>}
              {data.birthday && <div className="tiny"><strong>Birthday:</strong> {data.birthday}</div>}
              {data.notes ? (
                <div className="tiny">{data.notes}</div>
              ) : (
                !data.preferences && !data.birthday && <EmptyState message="No notes on file for this person yet." />
              )}
            </div>
          </div>

          {/* Every visit where this person was the recorded contact, most
              recent first — the "last time we spoke with them" history. */}
          <div className="card">
            <div className="card-head"><h2>Visit history ({data.visits.length})</h2></div>
            <div className="card-body">
              {data.visits.length === 0 ? (
                <EmptyState message="No visits logged with this person yet." />
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
                      {v.next_visit_date && <div className="tiny muted">Next visit: {v.next_visit_date}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <Button variant="danger" style={{ marginRight: 'auto' }} onClick={deletePerson} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete person'}
          </Button>
          <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
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
    </div>
  );
}
