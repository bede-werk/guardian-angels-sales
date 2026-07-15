// One-off address -> coordinates lookup, for capturing a rep's start-of-day
// location in the route planner (client/src/components/PlanVisits.jsx) when
// browser geolocation is denied/unavailable. geocodeAddress() itself already
// exists (services/geocoding.js) but until now was only ever called
// internally from routes/places.js's create/update handlers — this is the
// first caller that needs it as its own endpoint.
const express = require('express');
const { geocodeAddress } = require('../services/geocoding');

const router = express.Router();

// POST /api/geocode
// Body: { address, city, state, zip } (all optional, but at least one of
// address/city/zip is required — see geocodeAddress). Returns { lat, lng }
// or null if there's no match.
router.post('/', async (req, res, next) => {
  try {
    const { address, city, state, zip } = req.body;
    const coords = await geocodeAddress({ address, city, state, zip });
    res.json(coords);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
