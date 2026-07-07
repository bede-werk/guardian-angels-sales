import React from 'react';

// A reusable wrapper for the app's card layout (white box, header row with a
// title + optional action buttons, then a body). Matches the existing
// .card/.card-head/.card-body CSS classes so it looks identical to a
// hand-written <div className="card">.
//
// NOTE: none of the feature screens actually import this yet — they still
// write the .card/.card-head/.card-body divs out by hand. This component
// exists so new sections can use it going forward; it's safe but currently unused.
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
