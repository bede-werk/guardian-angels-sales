import React from 'react';

// Non-blocking "this might already exist" banner for creation forms. Doesn't
// stop submission — some near-matches are legitimate (a second branch of the
// same organization, two people who share a name) — it just surfaces what
// looks similar so a rep can check before adding a real duplicate.
export default function DuplicateWarning({ matches, label, renderMatch }) {
  if (!matches || matches.length === 0) return null;
  return (
    <div className="warning-banner">
      <strong>{label}</strong> may already be on file:
      <ul className="list" style={{ marginTop: 4 }}>
        {matches.map((m) => (
          <li key={m.id} className="tiny">{renderMatch(m)}</li>
        ))}
      </ul>
    </div>
  );
}
