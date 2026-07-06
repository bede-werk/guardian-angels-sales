import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { TierBadge, StatusBadge, OutcomeBadge } from './Badges';

// At-a-glance: today's route, visits completed this week, partners never visited.
export default function Dashboard({ date, userId, onGoToSchedule }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

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

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="grid stats">
        <div className="card stat">
          <div className="num">{data.today.count}</div>
          <div className="label">Stops on today's route</div>
          <div className="hint">{data.today.completed} completed · {data.today.planned} planned</div>
        </div>
        <div className="card stat">
          <div className="num">{data.completed_this_week.count}</div>
          <div className="label">Visits completed this week</div>
          <div className="hint">{data.week.start} → {data.week.end}</div>
        </div>
        <div className="card stat">
          <div className="num">{data.never_visited.count}</div>
          <div className="label">Partners never visited</div>
          <div className="hint">{neverPct}% of {data.never_visited.total_partners} total</div>
        </div>
      </div>

      <div className="grid cols2">
        <div className="card">
          <div className="card-head">
            <h2>Today's route — {data.date}</h2>
            <button className="btn small secondary" onClick={onGoToSchedule}>Open route</button>
          </div>
          <div className="card-body">
            {data.today.route.length === 0 ? (
              <div className="empty">No route yet. Go to <strong>Today's Route</strong> to generate one.</div>
            ) : (
              <ul className="list">
                {data.today.route.map((v, i) => (
                  <li key={v.visit_id} className={`stop ${v.status === 'completed' ? 'done' : ''}`}>
                    <div className="order">{i + 1}</div>
                    <div className="main">
                      <div className="name">{v.name}</div>
                      <div className="meta">{v.city} {v.zip} · {v.region}</div>
                      <div className="tag-list" style={{ marginTop: 4 }}>
                        <StatusBadge status={v.status} />
                        <OutcomeBadge outcome={v.outcome} />
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
              <div className="empty">Nothing completed yet this week.</div>
            ) : (
              <ul className="list">
                {data.completed_this_week.visits.map((v) => (
                  <li key={v.visit_id} className="stop">
                    <div className="main">
                      <div className="name tiny">{v.name}</div>
                      <div className="meta">{v.scheduled_date} · {v.city}</div>
                    </div>
                    <OutcomeBadge outcome={v.outcome} />
                  </li>
                ))}
              </ul>
            )}
          </div>
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
                <tr key={p.id}>
                  <td><strong>{p.name}</strong></td>
                  <td className="muted">{p.category}</td>
                  <td><TierBadge tier={p.tier} isPriority={p.is_priority} /></td>
                  <td className="muted tiny">{p.city} {p.zip} · {p.region}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
