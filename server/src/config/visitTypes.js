// Visit types the route planner understands, each with a default expected
// duration in minutes. Used by services/driveTime.js's time-block packing
// instead of a flat visit-duration assumption — a drop-in and an in-service
// presentation don't cost the same time, and packing needs to know which one
// it's budgeting for. A place's default_visit_type (see migration
// 20260713000000_add_default_visit_type_to_places.js) just pre-fills this
// choice when scheduling a visit there; every visit can still choose a
// different type.
//
// pre_qualification already existed as a concept (places' capacity/
// relationship fields are captured "at pre-qual" — see
// config/scheduling.js's comments) without its own duration or a place to
// live. It's folded in here as one of these types rather than becoming a
// second, separate mechanism.
//
// Plain module, same convention as config/scheduling.js and
// config/driveTime.js — kept as named constants so a future settings-table
// phase can lift them out without touching the packing logic.
module.exports = {
  VISIT_TYPES: {
    drop_in: { label: 'Drop-in', minutes: 7 },
    check_in: { label: 'Check-in', minutes: 18 }, // short relationship touch with one contact
    working_visit: { label: 'Working visit', minutes: 30 }, // longer sit-down meeting; replaces the old "standard" type
    presentation: { label: 'Presentation / in-service', minutes: 60 },
    pre_qualification: { label: 'Pre-qualification', minutes: 15 },
  },

  // Used when neither a visit nor its place specifies a type.
  DEFAULT_VISIT_TYPE: 'drop_in',

  // Flat per-stop overhead that isn't drive time and isn't the visit itself:
  // reviewing notes/history on the way in, logging the outcome on the way
  // out. Same for every visit type — unlike VISIT_TYPES, these don't vary by
  // what kind of visit it is.
  PREP_MINUTES: 3,
  DATA_ENTRY_MINUTES: 5,
};
