import React from 'react';
import Logo from './Logo';

// App header bar: the real logo lockup + a slot for right-side controls
// (date, signed-in-as, etc). One place so header structure stays consistent.
// `tagline` is the small grey line next to the logo; `children` is whatever
// App.jsx passes in as the right-aligned controls (date display, user menu).
export default function Header({ tagline, children }) {
  return (
    <header className="header">
      <div className="brand">
        <Logo variant="full-original" />
        {tagline && <div className="sub">{tagline}</div>}
      </div>
      <div className="controls">{children}</div>
    </header>
  );
}
