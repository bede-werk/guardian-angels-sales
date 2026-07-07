import React from 'react';

// One of the big number tiles at the top of the Dashboard (e.g. "0 / Stops on
// today's route / 0 completed · 0 planned"). `num` is the big number,
// `label` is the caption under it, `hint` is the small optional line under that.
export default function StatTile({ num, label, hint }) {
  return (
    <div className="card stat">
      <div className="num">{num}</div>
      <div className="label">{label}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
