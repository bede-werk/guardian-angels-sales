import React, { useEffect, useRef, useState } from 'react';

// Initials from a full name for the avatar bubble - "Lisa Marks" -> "LM".
// Falls back to the first letter alone if there's only one name part.
function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Upper-right profile control: an avatar button that opens a dropdown panel.
// Currently just the date, who's signed in, and log out - `children` lets
// more rows be dropped in above the log-out button later without touching
// this component.
export default function ProfileMenu({ name, date, onLogout, children }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="profile-menu" ref={boxRef}>
      <button
        type="button"
        className="profile-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className="profile-avatar">{initials(name)}</span>
      </button>

      {open && (
        <div className="profile-menu-panel">
          <div className="profile-menu-header">
            <span className="profile-avatar profile-avatar-lg">{initials(name)}</span>
            <div>
              <div className="profile-menu-name">{name}</div>
              <div className="profile-menu-date">{date}</div>
            </div>
          </div>

          {children && <div className="profile-menu-extra">{children}</div>}

          <button type="button" className="profile-menu-logout" onClick={onLogout}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
