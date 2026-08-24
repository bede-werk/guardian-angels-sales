// Adds the human capacity seed - the rep's own estimate of how many homecare
// referrals a place sends per month - and backfills it from the existing
// `tier`/`is_priority` pair.
//
// WHY THIS EXISTS
//
// capacity.js resolves a place's level from three sources, in order: a real
// pre-qual answer (`declared`), our own measured referral throughput
// (`measuredFloor`), and - when neither exists - a keyword match against the
// place's category (`categorySeedLevel`). Today 261 of 263 places fall all
// the way through to that last rung, so one entire axis of the cadence table
// is running on "the word 'Church' appeared in the category name."
//
// Meanwhile the rep's own read on each place already sits in the database as
// `tier` + `is_priority`, feeding nothing but a tie-break. Confirmed with
// Bede 2026-08-23: tier means "how much business could this place send us,"
// which is word-for-word capacity's own locked definition (see capacity.js's
// header - "the number of homecare referrals a place SENDS per month, to any
// agency... potential, not realized"). So tier is not a separate axis that
// happens to correlate with capacity; it IS a capacity reading, and it's a
// better-informed one than the keyword guess it's currently losing to.
//
// This is the same move `relationship_seed` made for the other axis
// (20260803000001), with one deliberate difference - see THE DECAY QUESTION.
//
// WHY FOUR VALUES, AND WHY THESE FOUR
//
// `tier` + `is_priority` looks like a 3-level scale plus an orthogonal flag,
// but it isn't: all 23 starred places are tier 1, so the pair has exactly
// four realised states and `priority_score` has exactly four values
// (100/75/50/25). Collapsing them into one four-choice rating is therefore
// lossless, which is what makes this backfill honest rather than a guess:
//
//   tier 1 + star -> 15/mo    (23 places)
//   tier 1        -> 13/mo    (25 places)
//   tier 2        ->  7/mo    (68 places)
//   tier 3        ->  1/mo   (147 places)
//
// Against CAPACITY_THRESHOLDS (low 0-3, medium 4-10, high 11+, retuned the
// same day from 6/16 - see config/scheduling.js) that resolves to 48 high /
// 68 medium / 147 low. The top two choices deliberately both land in `high`:
// capacity only has three levels, so any 4->3 mapping collapses somewhere,
// and the difference between "great account" and "best account" matters less
// for cadence than the difference between "occasional" and "steady." The
// distinction is not lost - it survives as `priority_score`, which is the
// EXPLORATION tier's tie-break within a capacity level.
//
// Every value sits at least 2 away from a bucket boundary on purpose. Both
// CAPACITY_THRESHOLDS values are independently editable from the Settings
// page (config/tunables.js, integers 1-1000, with no cross-validation against
// these seed values), so a value sitting ON a boundary - Bede's first draft
// had 11/mo against a HIGH_MIN of 11 - would let a one-digit threshold tweak
// silently re-level 25 places and halve their cadence. Same class of drift
// bug already caught once in the Rate Relationships preview (b8c4864).
//
// THE DECAY QUESTION - why this seed does NOT decay, and relationship's does
//
// `relationship_seed` decays because a relationship score IS a decaying
// quantity: the seed is denominated in the same units as decaying visit
// weight, so it washes out smoothly as real visits replace it.
//
// Capacity is a RATE, not a decaying quantity. A place that could send
// 10 referrals a month does not become a 3-a-month place because time
// passed, so decaying this value would silently demote every un-qualified
// place in the book - the exact opposite of the ratchet-only invariant
// capacity.js's header exists to protect.
//
// Capacity already has the mechanism a seed needs, and it is `confidence`,
// not decay. This seed sets a place's LEVEL only; it must never touch
// `confidence`, which stays 'unknown' until a real pre-qual answer lands.
// So a seeded place still sits in the EXPLORATION tier and still gets queued
// for verification - the seed makes its cadence honest today without making
// the system believe it knows anything. Nothing expires, nothing needs a
// cleanup task, and the seed is superseded outright the moment someone
// actually asks the place (capacity.js ignores the seed entirely when a
// `declared` observation exists - a guess does not get to floor the truth).
//
// TWO COLUMNS, AND WHAT NULL MEANS IN EACH
//
// `capacity_seed`      - the estimate itself, in referrals/month. Same unit
//                        as capacity_observations.monthly_referrals, so it is
//                        directly comparable to a real pre-qual answer.
// `capacity_seeded_at` - 'YYYY-MM-DD' (the date-only convention every other
//                        date column here uses), set ONLY when a human
//                        explicitly rates a place.
//
// The backfill deliberately leaves `capacity_seeded_at` NULL. That is what
// distinguishes "inherited from the spreadsheet tier, never actually
// reviewed" from "a rep looked at this place and rated it" - which is
// exactly the filter the rating screen needs to make a 263-place review pass
// tractable. Encoding it as a null date rather than a third provenance
// column keeps it to the minimum that answers the question.
//
// The four values are hardcoded here rather than read from config on
// purpose. A migration that reads mutable configuration produces a different
// database depending on when it runs; the config values govern the rating
// UI's choices from here on, this backfill is a one-time historical
// translation of data that already existed.
exports.up = async function up(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.integer('capacity_seed'); // referrals/month, the rep's own estimate
    t.string('capacity_seeded_at'); // 'YYYY-MM-DD', NULL = backfilled from tier, never explicitly rated
  });

  // Ordered most-specific first: the starred tier-1 rows must be claimed
  // before the plain tier-1 rule would otherwise swallow them.
  await knex('places').where({ tier: 1, is_priority: 1 }).update({ capacity_seed: 15 });
  await knex('places').where({ tier: 1, is_priority: 0 }).update({ capacity_seed: 13 });
  await knex('places').where({ tier: 2 }).update({ capacity_seed: 7 });
  await knex('places').where({ tier: 3 }).update({ capacity_seed: 1 });

  // A place with a tier outside 1-3 predates tierError()'s validation and has
  // no honest translation - leave its seed NULL so it falls through to the
  // category guess exactly as it does today, rather than inventing a number.
  const unseeded = await knex('places').whereNull('capacity_seed').count({ n: '*' }).first();
  if (Number(unseeded.n) > 0) {
    console.warn(`[20260823000000] ${unseeded.n} place(s) had a tier outside 1-3 and were left unseeded (they keep falling back to the category guess).`);
  }
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.dropColumn('capacity_seed');
    t.dropColumn('capacity_seeded_at');
  });
};
