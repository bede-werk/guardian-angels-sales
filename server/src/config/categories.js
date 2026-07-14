// Canonical place categories — the fixed enum a place's `category` column
// must come from, not free text. Matches this codebase's existing convention
// for tunables as a plain module (see config/scheduling.js, config/visitTypes.js).
//
// This is exactly the same 18 values already in use across every existing
// place (verified against the live DB 2026-07-14 — zero fragmentation yet),
// and the same list `20260712000000_add_scheduling_fields.js`'s capacity
// backfill keyword-matches against. Add a new category here (alphabetical,
// to match how it's rendered in the UI) when the business actually needs
// one — see routes/places.js for where this gets enforced server-side.
module.exports = [
  'Assisted Living & Senior Living',
  'Case Managers',
  'Churches',
  'Community Partners',
  'Concierge Doc',
  'Fire Stations',
  'Funeral Homes',
  'Home Medical Equipment',
  'Hospice',
  'Hospitals',
  'Legal & Trust',
  'Online Resource',
  'Pharmacies',
  'Physical Therapy',
  'Physicians',
  'Rehabilitation Centers',
  'Senior Advisors',
  'Vendors',
];
