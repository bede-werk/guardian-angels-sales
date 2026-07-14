// Small colored "pill" labels used throughout the app: tier/priority, visit
// status, visit outcome, and category. This file replaced the old Badges.jsx
// during the brand redesign — same idea, restyled with the brand tokens.
import React from 'react';
import { OUTCOME_LABELS } from '../../api';

// "Tier 1", "Tier 2", "Tier 3" + an optional "★ Priority" pill next to it.
export function TierChip({ tier, isPriority }) {
  return (
    <span className="tag-list">
      <span className={`badge t${tier}`}>Tier {tier}</span>
      {isPriority && <span className="badge star">★ Priority</span>}
    </span>
  );
}

// A visit's status: planned | completed | skipped. The CSS class is built
// from the status string directly (see .badge.status-* rules in styles.css).
export function StatusChip({ status }) {
  return <span className={`badge status-${status}`}>{status}</span>;
}

// A visit's outcome (interested / not_ready / follow_up / no_answer /
// left_materials). Renders nothing if no outcome has been logged yet.
export function OutcomeChip({ outcome }) {
  if (!outcome) return null;
  return <span className={`badge o-${outcome}`}>{OUTCOME_LABELS[outcome] || outcome}</span>;
}

// A place's Source Category (Hospitals, Hospice, Physicians, etc.) as a
// plain neutral pill — all categories share the same styling (see .cat-chip
// in styles.css).
export function CategoryChip({ category }) {
  if (!category) return null;
  return <span className="cat-chip">{category}</span>;
}
