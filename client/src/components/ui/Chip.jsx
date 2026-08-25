// Small colored "pill" labels used throughout the app: capacity, relationship,
// visit outcome/status, and category. This file replaced the old Badges.jsx
// during the brand redesign - same idea, restyled with the brand tokens.
//
// TierChip ("Tier 1/2/3" plus a "★ Priority" pill) lived here until
// 2026-08-23. Every surface that showed it now shows CapacityChip instead:
// tier was the rep's read on how much business a place could send, which is
// capacity's own definition, so the judgment moved to places.capacity_seed and
// the chip shows the level it resolves to. See server services/priority.js.
import React from 'react';
import { outcomeLabel, RELATIONSHIP_LABELS, CAPACITY_LABELS, CAPACITY_RATING_LABELS, VISIT_STATUS_LABELS } from '../../api';

// A visit's outcome (substantive / introduced_new / brief / materials_only /
// unavailable / declined). Renders nothing if no outcome has been logged yet.
// outcomeLabel() falls back to a prettified version of the raw value, so a
// pre-cutover outcome on an old row still reads as words rather than blank.
export function OutcomeChip({ outcome }) {
  if (!outcome) return null;
  return <span className={`badge o-${outcome}`}>{outcomeLabel(outcome)}</span>;
}

// A place's or person's computed relationship level. `overridden` is still
// passed through for the tooltip - the caller's subtext line (see
// RelationshipDetail.jsx) is what actually discloses "manually set" now, so
// the pill itself no longer repeats it as text.
export function RelationshipChip({ level, overridden }) {
  if (!level) return null;
  return (
    <span className={`badge rel-${level}`} title={overridden ? 'Set manually - see the subtext below for the computed value' : undefined}>
      {RELATIONSHIP_LABELS[level] || level}
    </span>
  );
}

// A place's computed capacity level (services/capacity.js). `overridden`
// works the same way RelationshipChip's does - the subtext line below it
// (see CapacityDetail.jsx) is what actually discloses "manually set."
export function CapacityChip({ level, overridden }) {
  if (!level) return null;
  return (
    <span className={`badge cap-${level}`} title={overridden ? 'Set manually - see the subtext below for the computed value' : undefined}>
      {CAPACITY_LABELS[level] || level}
    </span>
  );
}

// A place named as one of the ~25 that matter more than their referral volume
// says (places.is_all_star). Deliberately a star: it's the same judgment the
// retired ⭐ Priority flag was reaching for, now with a defined meaning, a real
// effect on cadence, and a visible count protecting its scarcity - see
// server migration 20260824000000 for why rebuilding it was intentional.
export function AllStarChip({ isAllStar }) {
  if (!isAllStar) return null;
  return <span className="badge all-star" title="All-star: one of the handful of places that matter most. Lifts its visit cadence unless it is already at the top.">★ All-star</span>;
}

// The rep's OWN capacity rating, as opposed to CapacityChip's computed level
// - "Major"/"Strong"/"Steady"/"Occasional" rather than high/medium/low. Only
// used where the input itself is the subject (the rating screen and the place
// form); every read-only list shows CapacityChip instead, so the app has one
// vocabulary for "how much can this place send" wherever it's just reporting.
//
// Takes the choice KEY, never the raw referrals/month number: those four
// numbers are Settings-editable, so a place rated before a retune holds a
// value that matches no current choice, and a chip built by matching numbers
// would silently render blank. Callers resolve the key with
// capacityRatingKey(), which is explicit about that mismatch.
export function CapacityRatingChip({ ratingKey }) {
  if (!ratingKey) return null;
  return <span className={`badge rate-${ratingKey}`}>{CAPACITY_RATING_LABELS[ratingKey] || ratingKey}</span>;
}

// A visit's status (planned/completed/skipped/snoozed) - the Visits tab's
// own column, since none of the single-place-or-person views needed a chip
// for it before (they already group visits by status into separate lists/
// cards instead).
export function StatusChip({ status }) {
  if (!status) return null;
  return <span className={`badge st-${status}`}>{VISIT_STATUS_LABELS[status] || status}</span>;
}

// A place's Source Category (Hospitals, Hospice, Physicians, etc.) as a
// plain neutral pill - all categories share the same styling (see .cat-chip
// in styles.css).
export function CategoryChip({ category }) {
  if (!category) return null;
  return <span className="cat-chip">{category}</span>;
}
