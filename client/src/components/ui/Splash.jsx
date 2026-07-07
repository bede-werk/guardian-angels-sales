import React, { useEffect, useState } from 'react';
import Logo from './Logo';

// Brand guide taglines, shown one at a time on the branded loading screen.
const TAGLINES = [
  'Care Guided by Something Greater',
  'In Every Moment, a Guardian',
  'Present. Patient. Purposeful.',
];

export default function Splash() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % TAGLINES.length), 2600);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="splash">
      <Logo variant="full-reverse" style={{ height: 56 }} />
      <div className="tagline">{TAGLINES[i]}</div>
    </div>
  );
}
