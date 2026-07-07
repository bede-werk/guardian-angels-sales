import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { TierChip, StatusChip, OutcomeChip, CategoryChip } from './ui/Chip';
import TemperatureDot from './ui/TemperatureDot';
import StatTile from './ui/StatTile';
import EmptyState from './ui/EmptyState';
import Button from './ui/Button';
import PartnerDetail from './PartnerDetail';

// At-a-glance: today's route, visits completed this week, partners never visited,
// and relationships that need attention (departed / cooling contacts, overdue visits).
export default function Dashboard({ date, userId, onGoToSchedule }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selectedPartnerId, setSelectedPartnerId] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.dashboard(userId, date));
    } catch (e) {
      setError(e.message);
    }
  }, [date, userId]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="loading">Loading dashboard…</div>;

  const neverPct = data.never_visited.total_partners
    ? Math.round((data.never_visited.count / data.never_visited.total_partners) * 100)
    : 0;
  const attention = data.needs_attention;

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="grid stats">
        <StatTile
          num={data.today.count}
          label="Stops on today's route"
          hint={`${data.today.completed} completed · ${data.today.planned} planned`}
        />
        <StatTile
          num={data.completed_this_week.count}
          label="Visits completed this week"
          hint={`${data.week.start} → ${data.week.end}`}
        />
        <StatTile
          num={data.never_visited.count}
          label="Partners never visited"
          hint={`${neverPct}% of ${data.never_visited.total_partners} total`}
        />
      </div>

      <div className="grid cols2">
        <div className="card">
          <div className="card-head">
            <h2>Today's route</h2>
            <Button size="small" variant="secondary" onClick={onGoToSchedule}>Open route</Button>
          </div>
          <div className="card-body">
            {data.today.route.length === 0 ? (
              <EmptyState
                message="No visits planned yet. Let's map out your day."
                action={<Button size="small" onClick={onGoToSchedule}>Plan today's visits</Button>}
              />
            ) : (
              <ul className="list">
                {data.today.route.map((v, i) => (
                  <li key={v.visit_id} className={`stop ${v.status === 'completed' ? 'done' : ''}`}>
                    <div className="order">{i + 1}</div>
                    <div className="main">
                      <div className="name">{v.name}</div>
                      <div className="meta">{v.city} {v.zip} · {v.region}</div>
                      <div className="tag-list" style={{ marginTop: 4 }}>
                        <StatusChip status={v.status} />
                        <OutcomeChip outcome={v.outcome} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h2>Completed this week</h2></div>
          <div className="card-body">
            {data.completed_this_week.visits.length === 0 ? (
              <EmptyState message="Nothing completed yet this week." />
            ) : (
              <ul className="list">
                {data.completed_this_week.visits.map((v) => (
                  <li key={v.visit_id} className="stop">
                    <div className="main">
                      <div className="name tiny">{v.name}</div>
                      <div className="meta">{v.scheduled_date} · {v.city}</div>
                    </div>
                    <OutcomeChip outcome={v.outcome} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Needs attention</h2>
          {attention.count > 0 && <span className="muted tiny">{attention.count} item{attention.count === 1 ? '' : 's'}</span>}
        </div>
        <div className="card-body">
          {attention.count === 0 ? (
            <EmptyState message="Nothing needs attention right now — every relationship is in good shape." />
          ) : (
            <ul className="list">
              {attention.overdue_partners.map((p) => (
                <li key={`overdue-${p.partner_id}`} className="stop attention-flag" style={{ cursor: 'pointer' }} onClick={() => setSelectedPartnerId(p.partner_id)}>
                  <div className="main">
                    <div className="name tiny">{p.name}</div>
                    <div className="meta">Next visit was due {p.next_visit_date} · {p.city}</div>
                  </div>
                  <CategoryChip category={p.category} />
                </li>
              ))}
              {attention.cooling_contacts.map((c) => (
                <li key={`cooling-${c.contact_id}`} className="stop attention-flag" style={{ cursor: 'pointer' }} onClick={() => setSelectedPartnerId(c.partner_id)}>
                  <div className="main">
                    <div className="name tiny">{c.contact_name} <span className="muted">· {c.partner_name}</span></div>
                  </div>
                  <TemperatureDot temp={c.relationship_temp} />
                </li>
              ))}
              {attention.departed_contacts.map((c) => (
                <li key={`departed-${c.contact_id}`} className="stop attention-flag" style={{ cursor: 'pointer' }} onClick={() => setSelectedPartnerId(c.partner_id)}>
                  <div className="main">
                    <div className="name tiny">{c.contact_name} <span className="muted">· {c.partner_name}</span></div>
                    <div className="meta">Departed — time to rebuild this relationship</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>High-priority partners never visited</h2>
          <span className="muted tiny">top {Math.min(12, data.never_visited.partners.length)} by priority</span>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>Organization</th><th>Category</th><th>Priority</th><th>Location</th></tr>
            </thead>
            <tbody>
              {data.never_visited.partners.slice(0, 12).map((p) => (
                <tr key={p.id} onClick={() => setSelectedPartnerId(p.id)}>
                  <td><strong>{p.name}</strong></td>
                  <td><CategoryChip category={p.category} /></td>
                  <td><TierChip tier={p.tier} isPriority={p.is_priority} /></td>
                  <td className="muted tiny">{p.city} {p.zip} · {p.region}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selectedPartnerId && (
        <PartnerDetail partnerId={selectedPartnerId} onClose={() => setSelectedPartnerId(null)} onChanged={load} />
      )}
    </div>
  );
}
