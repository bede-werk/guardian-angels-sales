// Adds `places.is_all_star` - the third axis: a scarce human designation of
// the handful of places that matter most.
//
// NOTE ON MEANING (corrected 2026-08-24, same day, before commit): this header
// originally defined an all-star as a place that "matters MORE than its
// referral volume says," i.e. a corrective flag scoped to low-volume sources.
// That was too narrow, and reasoning from it led to briefly calling the
// backfill below a mistake because all 23 seeded all-stars already read `high`
// capacity so the bump does nothing for them. Bede's actual meaning is the
// broader one: these are simply the ~25 places that matter most. An all-star
// that is already high-capacity is a normal, expected case - the flag lifts a
// place unless it is already at the top, and being already at the top is not a
// failure of the flag. Guardian Angels' own book happening to saturate says
// nothing about the design; another agency's top 25 will include low-volume
// sources, and the bump does real work there.
//
// WHY THIS EXISTS
//
// Capacity is locked as a COUNT ("the number of homecare referrals a place
// SENDS per month" - see services/capacity.js's header), and the `referrals`
// table carries no value, service type, case duration, or payer field. So
// nothing in the model can see that a trust attorney sending one client a
// quarter who needs 24/7 live-in care for three years is worth more than a PT
// clinic sending four short post-op cases a month. The attorney reads `low`
// capacity and gets a 90-day cadence.
//
// Bede's framing, and the reason this is a scarce flag rather than a
// per-place "referral value" rating: in homecare you only need ~20-25 genuine
// all-star referral sources, and the rest are ordinary. That makes this a
// decision about where a finite number of field days go - not an assessment
// of each place in isolation. A per-place value rating would have no natural
// ceiling and could drift to 90 "high-value" places; a top-25 list cannot
// inflate without someone noticing, which is the whole point.
//
// It is also why this is a general product feature rather than something
// tuned to one agency's book: the mechanism has to be right for whichever
// places a given company names, not for the shape of Guardian Angels' data
// on the day it shipped.
//
// THIS IS THE ⭐ PRIORITY FLAG, REBUILT DELIBERATELY - read before "simplifying"
//
// `places.is_priority` was retired ONE DAY BEFORE this migration (see
// 20260823000000 and services/priority.js). Bringing back a boolean flag on
// places is not an accident or a reversal; it's the same judgment given the
// three things the old one lacked, each of which is what killed it:
//
//   1. A DEFINED MEANING. "Priority" was never written down, so nothing could
//      say what qualified. This one means exactly: one of the ~25 places that
//      matter most, held to that number by ALL_STAR_TARGET and a visible count.
//   2. A REAL CONSEQUENCE. is_priority fed priority_score, a tie-break inside
//      one tier that almost nothing read - you could set it and observe no
//      change. is_all_star bumps the capacity row used for cadence lookup AND
//      the exploration tier's ordering (see schedulingEngine.js's
//      bumpCapacityLevel), so setting it visibly changes how often a place
//      comes up.
//   3. PROTECTED SCARCITY. A checkbox on every edit form has no sense of "25."
//      ALL_STAR_TARGET (config/scheduling.js, Settings-editable) plus a live
//      count surfaced wherever the flag is set is what keeps this from
//      drifting to 40 and then meaning nothing again. The cap is deliberately
//      SOFT - Bede's call: it warns past the target and lets it through,
//      rather than forcing a swap.
//
// If this flag ever stops changing anything observable, or the count stops
// being shown where it's set, it has regressed into the thing it replaced.
//
// WHY A PLAIN BOOLEAN AND NOT A LEVEL OR A DATE
//
// A place either earns one of the ~25 slots or it doesn't; grading all-stars
// against each other would re-introduce exactly the unbounded per-place
// rating this shape exists to avoid. No `all_star_at` either: unlike
// capacity_seeded_at (which distinguishes an inherited spreadsheet tier from a
// confirmed human read - a real question the rating queue depends on), this
// flag has no "inherited but unconfirmed" state to track. It's current-state,
// not a claim with an age.
//
// THE BACKFILL
//
// Seeded from the retired is_priority flag - the 23 places Bede had already
// starred, comfortably inside the 25 target. Same reasoning as 20260823000000
// backfilling capacity_seed from tier: an existing human judgment is a far
// better starting point than a blank slate, and it's the closest thing on file
// to the question being asked. "The ones I'd starred" and "the ones that
// matter most" are close enough to the same question that this is a good seed,
// which is why it was KEPT (Bede's call) after the meaning note above.
//
// All 23 read `high` capacity today, so bumpCapacityLevel changes nothing for
// any of them right now. That is expected, not a broken backfill - see the
// meaning note at the top.
exports.up = async function up(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.boolean('is_all_star').notNullable().defaultTo(false);
  });

  await knex('places').where({ is_priority: true }).update({ is_all_star: true });

  const seeded = await knex('places').where({ is_all_star: true }).count({ n: '*' }).first();
  console.log(`[20260824000000] seeded ${seeded.n} all-star place(s) from the retired is_priority flag.`);
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.dropColumn('is_all_star');
  });
};
