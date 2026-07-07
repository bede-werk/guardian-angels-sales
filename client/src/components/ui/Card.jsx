import React from 'react';

// Matches the existing .card/.card-head/.card-body structure so no markup shape changes.
export default function Card({ title, actions, children, bodyStyle, className = '' }) {
  return (
    <div className={`card ${className}`.trim()}>
      {title && (
        <div className="card-head">
          <h2>{title}</h2>
          {actions}
        </div>
      )}
      <div className="card-body" style={bodyStyle}>
        {children}
      </div>
    </div>
  );
}
