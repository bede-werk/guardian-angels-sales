// Address -> coordinates, via the US Census Bureau's free public geocoder
// (no API key required). Isolated here so the app only depends on this one
// function's shape ({ lat, lng } | null) — swapping providers later only
// means rewriting this file.
const ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/address';

// Looks up one address. Returns { lat, lng } for the first match, or null if
// there's no match or the request fails — geocoding is a best-effort
// enrichment and must never block creating/editing a place.
async function geocodeAddress({ address, city, state, zip }) {
  if (!address && !city && !zip) return null;

  const params = new URLSearchParams({
    benchmark: 'Public_AR_Current',
    format: 'json',
  });
  if (address) params.set('street', address);
  if (city) params.set('city', city);
  if (state) params.set('state', state);
  if (zip) params.set('zip', zip);

  try {
    const res = await fetch(`${ENDPOINT}?${params.toString()}`);
    if (!res.ok) return null;
    const data = await res.json();
    const match = data && data.result && data.result.addressMatches && data.result.addressMatches[0];
    if (!match || !match.coordinates) return null;
    return { lat: match.coordinates.y, lng: match.coordinates.x };
  } catch {
    return null;
  }
}

module.exports = { geocodeAddress };
