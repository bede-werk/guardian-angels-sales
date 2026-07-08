import React from 'react';

// The relationship-temperature scale (see people.relationship_temp): a
// small colored dot from full mauve (hot) down to full teal (dormant), each
// with its own CSS variable defined in styles.css's :root block.
const TEMP = {
  hot: { color: 'var(--temp-hot)', label: 'Hot' },
  warm: { color: 'var(--temp-warm)', label: 'Warm' },
  cold: { color: 'var(--temp-cold)', label: 'Cold' },
  dormant: { color: 'var(--temp-dormant)', label: 'Dormant' },
};

// Renders a contact's relationship temperature. Color for scanning, label for
// certainty — never rely on the dot color alone (accessibility: two of the
// four temperatures can look similar at a glance, so the text label is what
// actually disambiguates them). Pass showLabel={false} to show just the dot
// (e.g. in a tight space) — use sparingly since that breaks the color+label rule.
export default function TemperatureDot({ temp, showLabel = true }) {
  const t = TEMP[temp];
  if (!t) return null; // no temperature set for this contact — render nothing
  return (
    <span className="temp-dot-wrap">
      <span className="temp-dot" style={{ background: t.color }} />
      {showLabel && t.label}
    </span>
  );
}
