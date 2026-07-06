import React from 'react';
import { OUTCOME_LABELS } from '../api';

export function TierBadge({ tier, isPriority }) {
  return (
    <span className="tag-list">
      <span className={`badge t${tier}`}>Tier {tier}</span>
      {isPriority && <span className="badge star">★ Priority</span>}
    </span>
  );
}

export function StatusBadge({ status }) {
  return <span className={`badge status-${status}`}>{status}</span>;
}

export function OutcomeBadge({ outcome }) {
  if (!outcome) return null;
  return <span className={`badge o-${outcome}`}>{OUTCOME_LABELS[outcome] || outcome}</span>;
}
