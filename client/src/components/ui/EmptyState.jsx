import React from 'react';
import Logo from './Logo';

// The wing motif + warm, brand-voice copy — used everywhere a screen has nothing to
// show, instead of a blank space or a generic "No data" message.
// `message` is the copy text; `action` is an optional button/element rendered
// below it (e.g. a "Plan today's visits" button when the route is empty).
export default function EmptyState({ message, action }) {
  return (
    <div className="empty-state">
      <Logo variant="icon" className="empty-icon" />
      <div className="empty-message">{message}</div>
      {action}
    </div>
  );
}
