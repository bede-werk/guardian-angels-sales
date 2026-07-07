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

// Generated category palette: 9 blue tints + 9 teal tints, assigned to categories in
// alphabetical order, alternating hue. Mauve is deliberately excluded so it stays
// reserved for attention/urgent states. Unknown categories fall back to grey.
// To add a new category's color, just add a new entry here (or it'll use the
// grey fallback below until you do).
const CATEGORY_COLORS = {
  'Assisted Living & Senior Living': { bg: 'var(--blue-tint-1)', fg: 'var(--blue-dark)' },
  'Case Managers': { bg: 'var(--teal-tint-1)', fg: 'var(--teal-dark)' },
  'Churches': { bg: 'var(--blue-tint-2)', fg: 'var(--blue-dark)' },
  'Community Partners': { bg: 'var(--teal-tint-2)', fg: 'var(--teal-dark)' },
  'Concierge Doc': { bg: 'var(--blue-tint-3)', fg: 'var(--blue-dark)' },
  'Fire Stations': { bg: 'var(--teal-tint-3)', fg: 'var(--teal-dark)' },
  'Funeral Homes': { bg: 'var(--blue-tint-4)', fg: 'var(--blue-dark)' },
  'Home Medical Equipment': { bg: 'var(--teal-tint-4)', fg: 'var(--teal-dark)' },
  'Hospice': { bg: 'var(--blue-tint-5)', fg: 'var(--blue-dark)' },
  'Hospitals': { bg: 'var(--teal-tint-5)', fg: 'var(--teal-dark)' },
  'Legal & Trust': { bg: 'var(--blue-tint-6)', fg: 'var(--blue-dark)' },
  'Online Resource': { bg: 'var(--teal-tint-6)', fg: 'var(--teal-dark)' },
  'Pharmacies': { bg: 'var(--blue-tint-7)', fg: 'var(--blue-dark)' },
  'Physical Therapy': { bg: 'var(--teal-tint-7)', fg: 'var(--teal-dark)' },
  'Physicians': { bg: 'var(--blue-tint-8)', fg: 'var(--blue-dark)' },
  'Rehabilitation Centers': { bg: 'var(--teal-tint-8)', fg: 'var(--teal-dark)' },
  'Senior Advisors': { bg: 'var(--blue-tint-9)', fg: 'var(--blue-dark)' },
  'Vendors': { bg: 'var(--teal-tint-9)', fg: 'var(--teal-dark)' },
};
const FALLBACK_CATEGORY_COLOR = { bg: 'var(--grey-tint-1)', fg: 'var(--grey-dark)' };

// A place's Source Category (Hospitals, Hospice, Physicians, etc.) as a
// colored pill. Colors come from CATEGORY_COLORS above, applied as inline
// styles (rather than a CSS class per category) since the palette is data, not markup.
export function CategoryChip({ category }) {
  if (!category) return null;
  const { bg, fg } = CATEGORY_COLORS[category] || FALLBACK_CATEGORY_COLOR;
  return (
    <span className="cat-chip" style={{ background: bg, color: fg }}>
      {category}
    </span>
  );
}
