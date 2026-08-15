// Resolves planned visits whose scheduled_date has passed into 'skipped' -
// the passive half of the visit-terminal-states work (see HANDOFF.md; the
// deliberate half is the snooze endpoint in routes/visits.js).
//
// There is no background job infrastructure in this app (everything is
// request-driven), so this runs as router-level middleware instead of a
// cron: mounted on every router whose responses show a place/rep 'planned'
// visit status to a user (routes/visits.js, routes/places.js,
// routes/scheduleDrafts.js) so a stale row never reaches a screen still
// reading 'planned'. The UPDATE's own WHERE clause makes repeat calls cheap
// once a day's rows are already resolved - no separate "have I run today"
// tracking needed.
//
// Deliberately does nothing else: no cooldown, no consecutive-skip
// escalation, no touch of lastVisitedAt/urgency. See capacity-computation-
// spec.md's ranking model and HANDOFF.md - the absence of a completed visit
// is already the urgency signal; skip is just the audit trail for why one
// didn't happen.
const { orgToday } = require('./orgDate');

async function resolveLapsedPlannedVisits(knex) {
  return knex('visits')
    .where({ status: 'planned' })
    .where('scheduled_date', '<', orgToday())
    .update({ status: 'skipped', resolved_at: knex.fn.now() });
}

// The snooze commitment guard's actual decision, pulled out of routes/
// visits.js's POST /:id/snooze so it's testable the same way
// schedulingEngine.js's pure functions are - plain inputs, no knex. The
// caller is responsible for looking up `nextVisitDate` (the place's live
// commitment - same "most recent visit, by scheduled_date, that set one"
// query buildCandidatePool uses in scheduleDraft.js) and for applying
// `force`; this function only answers "would this snooze swallow it."
//
// Three cases: no commitment on file -> never a conflict. snoozedUntil
// strictly before nextVisitDate -> the commitment would still surface on
// its own before the snooze lifts, not a conflict. snoozedUntil on or
// after nextVisitDate -> place.snooze_until's existing precedence in
// schedulingEngine.js's eligibility() blocks the place unconditionally
// while snoozed (snooze is NOT one of the guards a due commitment bypasses
// - only the hard floor is), so the commitment would go dark for the
// whole snooze window. That's the conflict.
function snoozeSwallowsCommitment({ snoozedUntil, nextVisitDate }) {
  if (!nextVisitDate) return false;
  return snoozedUntil >= nextVisitDate;
}

// Express middleware wrapper - fire-and-continue, since a failure here must
// never block the actual request it's riding in on.
function skipSweepMiddleware(knex) {
  return async function skipSweep(req, res, next) {
    try {
      await resolveLapsedPlannedVisits(knex);
    } catch (err) {
      return next(err);
    }
    next();
  };
}

module.exports = { resolveLapsedPlannedVisits, skipSweepMiddleware, snoozeSwallowsCommitment };
