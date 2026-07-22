import React, { useState } from 'react';
import { SearchBox } from '@mapbox/search-js-react';

// Single-box "type freely, pick a suggestion" address search — the Google
// Maps-search equivalent for the route planner's manual start-location entry
// (replaces the old 4-field street/city/state/zip form). Wraps Mapbox's
// <SearchBox>, which owns its own network calls and dropdown internally as a
// custom element, so it can't reuse this app's .picker-menu/.picker-item
// classes directly — the theme values below are copied from the same design
// tokens instead (see :root in styles.css) so it still reads as part of the
// app rather than a dropped-in vendor widget.
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

// Lincoln, NE — biases results toward the area this app's places actually
// are without excluding matches elsewhere (a rep occasionally starts a day
// from home, out of town, etc.).
const LINCOLN_NE = { lng: -96.6852, lat: 40.8136 };

const THEME = {
  variables: {
    fontFamily: "'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    unit: '13px',
    padding: '8px 10px',
    borderRadius: '6px', // var(--radius-sm)
    border: '1px solid #E4E4E6', // var(--border)
    boxShadow: '0 1px 3px rgba(16, 24, 40, 0.08), 0 1px 2px rgba(16, 24, 40, 0.04)', // var(--shadow)
    colorPrimary: '#005CB9', // var(--blue)
    colorText: '#24272B', // var(--text)
    colorSecondary: '#818285', // var(--muted)
    colorBackground: '#fff',
    colorBackgroundHover: '#EAF2FB', // var(--blue-tint-1)
  },
};

// onSelect receives { lat, lng, label } — the same shape PlanVisits.jsx
// already builds from browser geolocation and the old manual-entry form, so
// callers don't need to know this uses Mapbox under the hood.
export default function AddressAutocomplete({ onSelect, placeholder = 'Start typing an address…' }) {
  const [error, setError] = useState(null);

  if (!MAPBOX_TOKEN) {
    return (
      <div className="tiny" style={{ color: 'var(--danger)' }}>
        Address search isn't configured (missing VITE_MAPBOX_TOKEN) — see client/.env.example.
      </div>
    );
  }

  return (
    <div>
      <SearchBox
        accessToken={MAPBOX_TOKEN}
        placeholder={placeholder}
        options={{ country: 'US', types: 'address', proximity: LINCOLN_NE }}
        theme={THEME}
        onRetrieve={(res) => {
          const feature = res.features && res.features[0];
          if (!feature) return;
          const [lng, lat] = feature.geometry.coordinates;
          const label = feature.properties.full_address || feature.properties.name;
          setError(null);
          onSelect({ lat, lng, label });
        }}
        onSuggestError={() => setError("Address search isn't responding — try again in a moment.")}
      />
      {error && <div className="tiny" style={{ color: 'var(--danger)', marginTop: 4 }}>{error}</div>}
    </div>
  );
}
