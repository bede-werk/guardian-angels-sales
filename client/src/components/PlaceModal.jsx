import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import Button from './ui/Button';
import PhoneInput, { isCompletePhone } from './ui/PhoneInput';
import DuplicateWarning from './ui/DuplicateWarning';
import useDuplicateMatches from '../hooks/useDuplicateMatches';

// Full name -> USPS abbreviation, so picking a suggestion can fill the State
// field the same way a rep would type it (Nominatim returns the full name).
const STATE_ABBREVIATIONS = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC',
};

// Address autocomplete via OpenStreetMap's Nominatim (free, no API key). Used
// only to help a rep pick a well-formed address while typing — the address
// actually gets (re-)geocoded server-side against the Census geocoder on save
// (see services/geocoding.js), so a bad/skipped suggestion here still works,
// it just won't have lat/lng right away.
async function searchAddress(query) {
  if (!query || query.trim().length < 4) return [];
  const params = new URLSearchParams({
    format: 'jsonv2',
    addressdetails: '1',
    countrycodes: 'us',
    limit: '5',
    q: query,
  });
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

// Create or edit a place (organization). `place` present = editing (form is
// pre-filled from it); absent = creating a brand-new one from a blank form.
// Opened from Places.jsx's "Add place" button, or PlaceDetail.jsx's "Edit" button.
export default function PlaceModal({ place, categories = [], onClose, onSaved }) {
  // category is a fixed enum (server/src/config/categories.js), not free
  // text — include the place's own current value defensively even if it
  // somehow isn't in the list, so editing never silently discards it.
  const categoryOptions = place?.category && !categories.includes(place.category)
    ? [place.category, ...categories]
    : categories;

  const [form, setForm] = useState({
    name: place?.name || '',
    category: place?.category || '',
    tier: place ? String(place.tier) : '3',
    is_priority: place?.is_priority || false,
    address: place?.address || '',
    city: place?.city || '',
    state: place?.state || 'NE',
    zip: place?.zip || '',
    phone: place?.phone || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (k) => () => setForm((f) => ({ ...f, [k]: !f[k] }));

  // Only warn on create — editing an existing place will always "match" itself.
  const duplicateMatches = useDuplicateMatches(
    form.name,
    (q) => api.places({ search: q }),
    { enabled: !place }
  );

  // Address autocomplete dropdown. `suppressNext` skips the next search-effect
  // run right after a suggestion is picked, so filling the field back in
  // doesn't immediately reopen the dropdown with a fresh search.
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suppressNext = useRef(false);

  useEffect(() => {
    if (suppressNext.current) { suppressNext.current = false; return; }
    const query = form.address.trim();
    if (query.length < 4) { setSuggestions([]); return; }
    const t = setTimeout(async () => {
      const results = await searchAddress(query);
      setSuggestions(results);
      setShowSuggestions(true);
    }, 350); // debounced, and well under Nominatim's 1 req/sec usage limit
    return () => clearTimeout(t);
  }, [form.address]);

  function pickSuggestion(s) {
    const a = s.address || {};
    const streetAddress = [a.house_number, a.road].filter(Boolean).join(' ') || s.display_name.split(',')[0];
    const city = a.city || a.town || a.village || a.hamlet || form.city;
    const state = STATE_ABBREVIATIONS[(a.state || '').toLowerCase()] || form.state;
    const zip = a.postcode || form.zip;

    suppressNext.current = true;
    setForm((f) => ({ ...f, address: streetAddress, city, state, zip }));
    setShowSuggestions(false);
    setSuggestions([]);
  }

  async function save() {
    if (!isCompletePhone(form.phone)) {
      setError('Phone must be a complete number, e.g. (402) 555-1234');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = place ? await api.updatePlace(place.id, form) : await api.createPlace(form);
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{place ? 'Edit place' : 'Add a place'}</h2>
          <button className="close" title="Close without saving" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          <div>
            <label className="field">Organization name</label>
            <input value={form.name} onChange={set('name')} autoFocus />
          </div>

          <DuplicateWarning
            matches={duplicateMatches}
            label="Similar place"
            renderMatch={(p) => `${p.name}${p.city ? ` — ${p.city}${p.zip ? ` ${p.zip}` : ''}` : ''}${p.category ? ` · ${p.category}` : ''}`}
          />

          <div className="row">
            <div>
              <label className="field">Category</label>
              <select value={form.category} onChange={set('category')}>
                <option value="">None</option>
                {categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="field">Tier</label>
              <select value={form.tier} onChange={set('tier')}>
                <option value="1">Tier 1</option>
                <option value="2">Tier 2</option>
                <option value="3">Tier 3</option>
              </select>
            </div>
          </div>

          <label className="tiny" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={form.is_priority} onChange={toggle('is_priority')} />
            ★ Priority
          </label>

          <div style={{ position: 'relative' }}>
            <label className="field">Address</label>
            <input
              value={form.address}
              onChange={set('address')}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder="Start typing to search…"
              autoComplete="off"
            />
            {showSuggestions && suggestions.length > 0 && (
              <ul
                className="list"
                style={{
                  position: 'absolute', zIndex: 10, top: '100%', left: 0, right: 0,
                  background: 'var(--card)', border: '1px solid var(--border)',
                  borderRadius: 6, marginTop: 2, maxHeight: 220, overflowY: 'auto',
                }}
              >
                {suggestions.map((s) => (
                  <li key={s.place_id}>
                    <button
                      type="button"
                      className="link-row"
                      style={{
                        display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px',
                        border: 'none', background: 'none', cursor: 'pointer',
                      }}
                      onMouseDown={(e) => e.preventDefault()} // keep the input's onBlur from firing before the click registers
                      onClick={() => pickSuggestion(s)}
                    >
                      {s.display_name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="row">
            <div>
              <label className="field">City</label>
              <input value={form.city} onChange={set('city')} />
            </div>
            <div style={{ maxWidth: 100 }}>
              <label className="field">State</label>
              <input value={form.state} onChange={set('state')} />
            </div>
            <div style={{ maxWidth: 140 }}>
              <label className="field">Zip</label>
              <input value={form.zip} onChange={set('zip')} />
            </div>
          </div>

          <div>
            <label className="field">Phone</label>
            <PhoneInput value={form.phone} onChange={(v) => setForm((f) => ({ ...f, phone: v }))} />
          </div>
        </div>
        <div className="modal-foot">
          <Button variant="secondary" title="Close without saving" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button
            title={place ? "Save changes to this place's details" : 'Create this new place'}
            onClick={save}
            disabled={saving || !form.name.trim() || !isCompletePhone(form.phone)}
          >
            {saving ? 'Saving…' : place ? 'Save changes' : 'Add place'}
          </Button>
        </div>
      </div>
    </div>
  );
}
