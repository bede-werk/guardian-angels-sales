// Tunables for the Dashboard rollup (routes/dashboard.js). Same convention
// as config/referrals.js - plain module of named constants, registered in
// config/tunables.js so the Settings page can move them, read at call time
// (never destructured at require time) so an override actually lands.
//
// Nothing here changes what the planner DOES; these only decide how much of
// the truth the five dashboard cards show at once.
module.exports = {
  // How far ahead "Commitments due" looks. Overdue commitments are always
  // included regardless of this number - an unkept promise doesn't stop
  // being due because it aged out of a forward window.
  COMMITMENT_HORIZON_DAYS: 14,

  // Cap on the commitments list itself, so a book with fifty outstanding
  // promises doesn't turn the dashboard into a scrolling backlog. The
  // counts above the list are never capped - they always count everything
  // in the horizon.
  COMMITMENT_LIST_LIMIT: 12,

  // How many of the most recent referrals the "Recent referrals" card lists.
  // The headline count next to it uses referrals.RECENT_WINDOW_DAYS instead,
  // so the two answer different questions on purpose: "what just came in"
  // and "how much came in lately."
  RECENT_REFERRALS_LIMIT: 8,

  // How many people the "Top referral partners" leaderboard shows.
  TOP_PARTNERS_LIMIT: 10,
};
