// Small colored "pill" labels used throughout the app: tier/priority, visit
// outcome, and category. This file replaced the old Badges.jsx during the
// brand redesign — same idea, restyled with the brand tokens.
import React from 'react';
import { outcomeLabel, RELATIONSHIP_LABELS } from '../../api';

// "Tier 1", "Tier 2", "Tier 3" + an optional "★ Priority" pill next to it.
export function TierChip({ tier, isPriority }) {
  return (
    <span className="tag-list">
      <span className={`badge t${tier}`}>Tier {tier}</span>
      {isPriority && <span className="badge star">★ Priority</span>}
    </span>
  );
}

// A visit's outcome (substantive / introduced_new / brief / materials_only /
// unavailable / declined). Renders nothing if no outcome has been logged yet.
// outcomeLabel() falls back to a prettified version of the raw value, so a
// pre-cutover outcome on an old row still reads as words rather than blank.
export function OutcomeChip({ outcome }) {
  if (!outcome) return null;
  return <span className={`badge o-${outcome}`}>{outcomeLabel(outcome)}</span>;
}

// A place's or person's computed relationship level. `overridden` is still
// passed through for the tooltip — the caller's subtext line (see
// RelationshipDetail.jsx) is what actually discloses "manually set" now, so
// the pill itself no longer repeats it as text.
export function RelationshipChip({ level, overridden }) {
  if (!level) return null;
  return (
    <span className={`badge rel-${level}`} title={overridden ? 'Set manually — see the subtext below for the computed value' : undefined}>
      {RELATIONSHIP_LABELS[level] || level}
    </span>
  );
}

// A place's Source Category (Hospitals, Hospice, Physicians, etc.) as a
// plain neutral pill — all categories share the same styling (see .cat-chip
// in styles.css).
export function CategoryChip({ category }) {
  if (!category) return null;
  return <span className="cat-chip">{category}</span>;
}
