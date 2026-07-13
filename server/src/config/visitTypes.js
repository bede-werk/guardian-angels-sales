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
    drop_in: { label: 'Drop-in', minutes: 10 },
    standard: { label: 'Standard', minutes: 25 },
    presentation: { label: 'Presentation / in-service', minutes: 45 },
    pre_qualification: { label: 'Pre-qualification', minutes: 20 },
  },

  // Used when neither a visit nor its place specifies a type.
  DEFAULT_VISIT_TYPE: 'standard',
};
