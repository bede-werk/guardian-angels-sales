import React from 'react';

const TEMP = {
  hot: { color: 'var(--temp-hot)', label: 'Hot' },
  warm: { color: 'var(--temp-warm)', label: 'Warm' },
  cold: { color: 'var(--temp-cold)', label: 'Cold' },
  dormant: { color: 'var(--temp-dormant)', label: 'Dormant' },
};

// Color for scanning, label for certainty — never rely on the dot color alone.
export default function TemperatureDot({ temp, showLabel = true }) {
  const t = TEMP[temp];
  if (!t) return null;
  return (
    <span className="temp-dot-wrap">
      <span className="temp-dot" style={{ background: t.color }} />
      {showLabel && t.label}
    </span>
  );
}
