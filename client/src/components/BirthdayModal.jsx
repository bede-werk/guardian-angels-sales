import React from 'react';
import EmptyState from './ui/EmptyState';
import useClosingTransition from '../hooks/useClosingTransition';

// A day's birthdays - the Calendar tab's 🎂 badge (VisitsCalendar.jsx).
// Every row here is just a person + their place (if any), no visit/status
// involved - clicking one opens that person's full PersonDetail. `label` is
// the caller-formatted "{Month} {day}" string (birthdays have no year on
// file, so there's no real date to format via the usual formatDate helper).
export default function BirthdayModal({ label, people, onClose, onViewPerson }) {
  const { closing, requestClose } = useClosingTransition(onClose);
  return (
    <div className={`modal-backdrop${closing ? " closing" : ""}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{label} · Birthdays</h2>
          <button className="close" title="Close" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body">
          {people.length === 0 ? (
            <EmptyState message="No birthdays this day." />
          ) : (
            <ul className="list">
              {people.map((p) => (
                <li
                  key={p.id}
                  className="stack hover-row"
                  style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}
                  onClick={() => onViewPerson(p.id)}
                >
                  <span style={{ fontFamily: 'var(--font-serif)', fontWeight: 600, fontSize: 15 }}>
                    {p.name}
                  </span>
                  {p.place_name && <div className="tiny muted">{p.place_name}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
