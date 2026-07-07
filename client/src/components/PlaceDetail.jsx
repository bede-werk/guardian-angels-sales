import React, { useEffect, useState } from 'react';
import { api, navigateUrl, ROLE_TYPE_LABELS } from '../api';
import { TierChip, StatusChip, OutcomeChip, CategoryChip } from './ui/Chip';
import TemperatureDot from './ui/TemperatureDot';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import VisitLogModal from './VisitLogModal';
import ContactModal from './ContactModal';

// One card in the "People here" grid: a person's name/title/role/temperature,
// plus quick call/email links and an Edit button (opens ContactModal).
function ContactCard({ contact, onEdit }) {
  return (
    <div className={`contact-card ${contact.departed ? 'departed' : ''}`}>
      <div className="tag-list" style={{ justifyContent: 'space-between' }}>
        <span className="contact-name">{contact.name}</span>
        {contact.is_primary && <span className="badge star">★ Primary</span>}
      </div>
      {contact.title && <div className="tiny muted">{contact.title}</div>}
      <div className="tag-list">
        {contact.role_type && <span className="contact-role">{ROLE_TYPE_LABELS[contact.role_type]}</span>}
        {contact.relationship_temp && <TemperatureDot temp={contact.relationship_temp} />}
        {contact.departed && <span className="badge" style={{ background: 'var(--mauve-tint-2)', color: 'var(--mauve)' }}>Departed</span>}
      </div>
      <div className="contact-actions">
        {contact.phone && <a className="btn ghost small" href={`tel:${contact.phone}`}>Call</a>}
        {contact.email && <a className="btn ghost small" href={`mailto:${contact.email}`}>Email</a>}
        <Button variant="ghost" size="small" onClick={() => onEdit(contact)}>Edit</Button>
      </div>
    </div>
  );
}

// Slide-in modal: place details + people here + full visit history + "log a
// visit" action. Opened from Places.jsx (clicking a row) or Dashboard.jsx
// (clicking any place-linked row/card).
export default function PlaceDetail({ placeId, onClose, onChanged }) {
  const [data, setData] = useState(null); // GET /api/places/:id response (place + visits + contacts)
  const [logging, setLogging] = useState(false); // whether the Log Visit modal is open
  // Controls the (Add/Edit) contact modal: undefined = closed, null = creating
  // a brand-new contact, an object = editing that existing contact.
  const [editingContact, setEditingContact] = useState(undefined);

  async function load() {
    setData(await api.place(placeId));
  }
  useEffect(() => {
    load();
  }, [placeId]);

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
          </div>
          <div className="tag-list">
            <Button variant="secondary" size="small" onClick={() => window.open(navigateUrl(data), '_blank')}>Navigate</Button>
            {/* Call button only shows if this place has a phone number on file
                (not populated from the original Excel import — added manually). */}
            {data.phone && <a className="btn secondary small" href={`tel:${data.phone}`}>Call</a>}
          </div>

          {/* People here: every contact (person) recorded at this place. */}
          <div className="card">
            <div className="card-head">
              <h2>People here ({data.contacts.length})</h2>
              <Button variant="secondary" size="small" onClick={() => setEditingContact(null)}>Add contact</Button>
            </div>
            <div className="card-body">
              {data.contacts.length === 0 ? (
                <EmptyState message="No one on file here yet. Add the people you meet so the team knows who to ask for." />
              ) : (
                <div className="contact-grid">
                  {data.contacts.map((c) => (
                    <ContactCard key={c.id} contact={c} onEdit={setEditingContact} />
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
                          from the durable contacts list above. */}
                      {(v.contact_name || v.contact_email || v.contact_phone) && (
                        <div className="tiny muted">
                          {[v.contact_name, v.contact_title].filter(Boolean).join(', ')}
                          {v.contact_email ? ` · ${v.contact_email}` : ''}
                          {v.contact_phone ? ` · ${v.contact_phone}` : ''}
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

      {/* Add/Edit contact modal — only rendered when editingContact isn't undefined. */}
      {editingContact !== undefined && (
        <ContactModal
          placeId={data.id}
          contact={editingContact}
          onClose={() => setEditingContact(undefined)}
          onSaved={() => { load(); onChanged?.(); }}
        />
      )}
    </div>
  );
}
