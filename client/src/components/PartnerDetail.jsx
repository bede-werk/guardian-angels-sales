import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { TierBadge, StatusBadge, OutcomeBadge } from './Badges';
import VisitLogModal from './VisitLogModal';

// Slide-in modal: partner details + full visit history + "log a visit" action.
export default function PartnerDetail({ partnerId, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [logging, setLogging] = useState(false);

  async function load() {
    setData(await api.partner(partnerId));
  }
  useEffect(() => {
    load();
  }, [partnerId]);

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
            <div className="tiny muted">{data.category}</div>
          </div>
          <button className="close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <TierBadge tier={data.tier} isPriority={data.is_priority} />
          <div className="tiny">
            {data.address && <div>{data.address}</div>}
            <div>{data.city}, {data.state} {data.zip} · <strong>{data.region}</strong></div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Visit history ({data.visits.length})</h2></div>
            <div className="card-body">
              {data.visits.length === 0 ? (
                <div className="empty">No visits logged yet.</div>
              ) : (
                <ul className="list">
                  {data.visits.map((v) => (
                    <li key={v.id} className="stack" style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
                      <div className="tag-list">
                        <strong className="tiny">{v.scheduled_date || 'unscheduled'}</strong>
                        <StatusBadge status={v.status} />
                        <OutcomeBadge outcome={v.outcome} />
                        {v.user_name && <span className="tiny muted">· {v.user_name}</span>}
                      </div>
                      {v.notes && <div className="tiny">{v.notes}</div>}
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
          <button className="btn" onClick={() => setLogging(true)}>Log a visit</button>
        </div>
      </div>

      {logging && (
        <VisitLogModal
          partnerId={data.id}
          partnerName={data.name}
          onClose={() => setLogging(false)}
          onSaved={() => { load(); onChanged?.(); }}
        />
      )}
    </div>
  );
}
