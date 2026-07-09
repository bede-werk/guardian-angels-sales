import React, { useEffect, useState } from 'react';
import { api, ROLE_TYPE_LABELS } from '../api';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import PersonModal from './PersonModal';
import ReferralModal from './ReferralModal';

// Slide-in modal: a person's own detail — their place, contact info,
// durable notes/preferences, and every visit where they were the recorded
// contact (their personal "last time we spoke" history). Opened from
// People.jsx (clicking a row).
export default function PersonDetail({ personId, onClose, onChanged, onDeleted, onOpenPlace }) {
  const [data, setData] = useState(null); // GET /api/people/:id response (person + place + visits)
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [places, setPlaces] = useState([]); // every place, for the "assign to a place" picker
  const [removingFromPlace, setRemovingFromPlace] = useState(false);
  const [assigning, setAssigning] = useState(false); // whether the "assign to a place" picker is open
  const [placeDraft, setPlaceDraft] = useState('');
  const [removingReferralId, setRemovingReferralId] = useState(null); // referral currently being deleted (disables its row)
  const [loggingReferral, setLoggingReferral] = useState(false); // whether the Log Referral modal is open

  async function load() {
    setData(await api.people.get(personId));
  }
  useEffect(() => {
    load();
  }, [personId]);
  useEffect(() => {
    api.places({}).then(setPlaces).catch(() => {});
  }, []);

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

  if (!data) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="loading">Loading…</div>
        </div>
      </div>
    );
  }

  const { referral_metrics: metrics } = data;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{data.name}</h2>
            <div className="tag-list" style={{ marginTop: 4 }}>
              {data.title && <span className="tiny muted">{data.title}</span>}
              {data.role_type && <span className="contact-role">{ROLE_TYPE_LABELS[data.role_type]}</span>}
              {data.is_primary && <span className="badge star">★ Primary</span>}
              {data.departed && <span className="badge" style={{ background: 'var(--mauve-tint-2)', color: 'var(--mauve)' }}>Departed</span>}
              <span className="badge" style={{ background: 'var(--teal-tint-2)', color: 'var(--teal-dark)' }}>
                {metrics.lifetime_referrals} referral{metrics.lifetime_referrals === 1 ? '' : 's'}
              </span>
              {metrics.needs_attention && (
                <span className="badge attention" title="Referred before, but nothing in the last 90 days">
                  Cooling — needs attention
                </span>
              )}
            </div>
          </div>
          <button className="close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {/* Which place they belong to — or, since a person doesn't have to
              be tied to one, a way to assign them to one. */}
          <div className="card">
            <div className="card-body">
              {data.place ? (
                <div className="row" style={{ alignItems: 'center' }}>
                  <div>
                    <strong>{data.place.name}</strong>
                    <div className="tiny muted">{data.place.city}, {data.place.state} {data.place.zip}</div>
                  </div>
                  <div className="tag-list" style={{ flex: 'unset' }}>
                    <Button variant="secondary" size="small" onClick={() => onOpenPlace?.(data.place.id)}>View place</Button>
                    <Button variant="ghost" size="small" onClick={removeFromPlace} disabled={removingFromPlace}>
                      {removingFromPlace ? 'Removing…' : 'Remove from place'}
                    </Button>
                  </div>
                </div>
              ) : assigning ? (
                <div className="row" style={{ alignItems: 'center' }}>
                  <select value={placeDraft} onChange={(e) => setPlaceDraft(e.target.value)} autoFocus>
                    <option value="">Select a place…</option>
                    {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <div className="tag-list" style={{ flex: 'unset' }}>
                    <Button size="small" onClick={assignToPlace} disabled={!placeDraft}>Save</Button>
                    <Button variant="secondary" size="small" onClick={() => setAssigning(false)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="row" style={{ alignItems: 'center' }}>
                  <EmptyState message="Not currently assigned to a place." />
                  <Button variant="secondary" size="small" onClick={() => setAssigning(true)}>Assign to a place</Button>
                </div>
              )}
            </div>
          </div>

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

          {/* Every referral this person has sent us, most recent first, plus
              the three headline metrics computed live from that list (see
              services/referralMetrics.js) — no manual "temperature" to set. */}
          <div className="card">
            <div className="card-head">
              <h2>Referrals ({metrics.lifetime_referrals})</h2>
              <Button size="small" onClick={() => setLoggingReferral(true)}>Log a referral</Button>
            </div>
            <div className="card-body stack">
              <div className="tiny muted">
                Last referral: {metrics.last_referral_date || 'none yet'} · {metrics.referrals_last_90_days} in the last 90 days
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
                    <li key={r.id} className="stack" style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                      <div className="tag-list" style={{ justifyContent: 'space-between' }}>
                        <strong className="tiny">{r.referral_date || 'no date'}</strong>
                        <Button
                          variant="danger"
                          size="small"
                          title="Delete this referral"
                          disabled={removingReferralId === r.id}
                          onClick={() => removeReferral(r)}
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
                    <li key={v.id} className="stack" style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
                      <div className="tag-list">
                        <strong className="tiny">{v.scheduled_date || 'unscheduled'}</strong>
                        {v.place_name && <span className="tiny muted">· at {v.place_name}</span>}
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

      {loggingReferral && (
        <ReferralModal
          person={{ id: data.id, name: data.name }}
          onClose={() => setLoggingReferral(false)}
          onSaved={() => { load(); onChanged?.(); }}
        />
      )}
    </div>
  );
}
