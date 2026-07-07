import React, { useEffect, useState } from 'react';
import Logo from './Logo';

// Brand guide taglines, shown one at a time on the branded loading screen.
const TAGLINES = [
  'Care Guided by Something Greater',
  'In Every Moment, a Guardian',
  'Present. Patient. Purposeful.',
];

// Full-bleed blue "branded loading" screen — shown by App.jsx while it's
// checking whether a saved login session is still valid. Cycles through the
// taglines above every ~2.6s for as long as it's on screen.
export default function Splash() {
  const [i, setI] = useState(0); // index into TAGLINES of the one currently shown
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % TAGLINES.length), 2600);
    return () => clearInterval(t); // stop the rotation once the splash unmounts
  }, []);

  return (
    <div className="splash">
      <Logo variant="full-reverse" style={{ height: 56 }} />
      <div className="tagline">{TAGLINES[i]}</div>
    </div>
  );
}
