import React, { useId, useState } from 'react';
import { api, MONTH_NAMES, daysInMonth } from '../api';
import Button from './ui/Button';
import PhoneInput, { isCompletePhone } from './ui/PhoneInput';
import PlaceModal from './PlaceModal';
import { runPreSaveCheck } from '../hooks/usePreSaveCheck';
import useClosingTransition from '../hooks/useClosingTransition';

// The place picker's last option is a sentinel that opens a nested PlaceModal
// instead of actually picking a place - same pattern as the category filter
// dropdowns' "Manage categories…" entry (People.jsx/Places.jsx).
const ADD_PLACE_OPTION = '__add_place__';

// Create or edit a person. `person` present = editing (form is pre-filled from
// it); absent = creating a brand-new one from a blank form.
// Opened from PlaceDetail.jsx's "New person" button or PersonDetail.jsx's
// "Edit" button (both pass a fixed `placeId`), or from People.jsx's
// "+ Add person" button (passes `places`/`categories` instead, so the form
// includes a place picker that can also create a brand-new place on the fly).
export default function PersonModal({ placeId, placeName, places, categories, person, onClose, onSaved, onCategoriesChanged }) {
  const { closing, requestClose } = useClosingTransition(onClose);
  // See PlaceModal's identical comment - pairs every label.field below with
  // its input via htmlFor/id.
  const uid = useId();
  const [form, setForm] = useState({
    place_id: placeId || person?.place_id || '',
    name: person?.name || '',
    title: person?.title || '',
    email: person?.email || '',
    phone: person?.phone || '',
    birthday_month: person?.birthday_month || '',
    birthday_day: person?.birthday_day || '',
    preferences: person?.preferences || '',
    notes: person?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  // Pre-save findings, as { title, detail } pairs - a possible duplicate is
  // the only one this form can raise. Shown inline in the footer next to
  // Save, which becomes "Add anyway"; NOT a second modal stacked on top of
  // this one. Same convention PlanVisitModal/VisitLogModal use for the
  // cross-rep collision warnings: nothing failed and nothing is blocked, so
  // the form stays exactly where it is and the rep decides.
  const [warnings, setWarnings] = useState(null);
  const [addingPlace, setAddingPlace] = useState(false); // nested "add a new place" modal open?
  // Places created via the nested modal this session - merged into the
  // dropdown's options since the `places` prop won't include it until the
  // parent (People.jsx) reloads its own place list.
  const [extraPlaces, setExtraPlaces] = useState([]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value })); // wires a text input/select to `form`

  function handlePlaceChange(e) {
    if (e.target.value === ADD_PLACE_OPTION) { setAddingPlace(true); return; }
    setForm((f) => ({ ...f, place_id: e.target.value }));
  }

  // The duplicate-name warning is fetched fresh right here (never from a
  // debounced background hook, which could still be mid-flight and stale at
  // the moment of clicking) and appears when Save is actually clicked, not
  // while the rep is still typing. Only warn on create - editing an existing
  // person will always "match" itself. Name-only (routes/people.js's
  // check-duplicate, a dedicated endpoint - not the general list `search`,
  // which also matches title and would false-positive on shared job titles).
  async function save() {
    if (!isCompletePhone(form.phone)) {
      setError('Phone must be a complete number, e.g. (402) 555-1234');
      return;
    }
    // A second click with the warning already showing IS the confirmation -
    // skip the re-check and save. (The name can't have changed since the
    // check ran: editing it clears `warnings`.)
    if (!person && !warnings && form.name.trim().length >= 3) {
      const result = await runPreSaveCheck(setSaving, setError, () => api.people.checkDuplicate(form.name.trim()));
      if (!result.ok) return;
      const matches = result.value;
      if (matches.length > 0) {
        const names = matches.slice(0, 5).map((m) => m.name).join(', ');
        setWarnings([{ title: 'Possible duplicate', detail: `A similar person may already be on file: ${names}.` }]);
        return;
      }
    }
    finishSave();
  }

  // PATCH if editing an existing person, POST if creating a new one. Runs
  // after the duplicate-name check (if any) has already been cleared.
  async function finishSave() {
    setSaving(true);
    setError(null);
    // A confirmed resend that hits a FRESH problem must not leave the old
    // warning on screen next to the new error - same reasoning as
    // PlanVisitModal's setWarnings(null) before its own retry.
    setWarnings(null);
    try {
      const saved = person
        ? await api.people.update(person.id, form)
        : await api.people.create({ ...form, place_id: placeId || form.place_id || null });
      onSaved?.(saved);
      requestClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  const needsPlacePicker = !placeId && !person && places;

  return (
    <div className={`modal-backdrop${closing ? " closing" : ""}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{person ? 'Edit Person' : placeName ? `Add a Person · ${placeName}` : 'Add a Person'}</h2>
          <button className="close" title="Close without saving" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          {needsPlacePicker && (
            <div>
              <label className="field" htmlFor={`${uid}-place`}>Place</label>
              <select id={`${uid}-place`} value={form.place_id} onChange={handlePlaceChange}>
                <option value="">No place (unassigned)</option>
                <option value={ADD_PLACE_OPTION}>+ Add a new place…</option>
                <option disabled>──────────</option>
                {[...places, ...extraPlaces.filter((ep) => !places.some((p) => p.id === ep.id))]
                  .map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}

          <div className="row">
            <div>
              <label className="field" htmlFor={`${uid}-name`}>Name</label>
              {/* Clears the duplicate warning: it was raised about this
                  exact string, so editing it makes the answer stale and the
                  next Save has to re-check rather than push past. */}
              <input
                id={`${uid}-name`}
                value={form.name}
                onChange={(e) => { set('name')(e); setWarnings(null); }}
                autoFocus
              />
            </div>
            <div>
              <label className="field" htmlFor={`${uid}-title`}>Title</label>
              <input id={`${uid}-title`} value={form.title} onChange={set('title')} />
            </div>
          </div>

          <div className="row">
            <div>
              <label className="field" htmlFor={`${uid}-email`}>Email</label>
              <input id={`${uid}-email`} type="email" value={form.email} onChange={set('email')} />
            </div>
            <div>
              <label className="field" htmlFor={`${uid}-phone`}>Phone</label>
              <PhoneInput id={`${uid}-phone`} value={form.phone} onChange={(v) => setForm((f) => ({ ...f, phone: v }))} />
            </div>
          </div>

          <div>
            <label className="field" htmlFor={`${uid}-preferences`}>Preferences</label>
            <input id={`${uid}-preferences`} value={form.preferences} onChange={set('preferences')} placeholder="Coffee order, how they like to be reached…" />
          </div>

          <div>
            <label className="field" htmlFor={`${uid}-notes`}>Notes</label>
            <textarea id={`${uid}-notes`} rows={2} value={form.notes} onChange={set('notes')} />
          </div>

          <div>
            <label className="field" htmlFor={`${uid}-birthday-month`}>Birthday</label>
            <div className="row">
              <select
                id={`${uid}-birthday-month`}
                value={form.birthday_month}
                onChange={(e) => setForm((f) => ({ ...f, birthday_month: e.target.value, birthday_day: '' }))}
              >
                <option value="">Month</option>
                {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
              <select
                id={`${uid}-birthday-day`}
                aria-label="Day"
                value={form.birthday_day}
                onChange={set('birthday_day')}
                disabled={!form.birthday_month}
              >
                <option value="">Day</option>
                {Array.from({ length: daysInMonth(Number(form.birthday_month)) }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
        {/* The warning shares the sticky footer with Save (flex: 1 +
            minWidth: 0 so long text wraps in place instead of shoving the
            button onto its own line - see PlanVisitModal's identical
            notice), which keeps it on screen no matter how far the form is
            scrolled. */}
        <div className="modal-foot" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {warnings?.map((w, i) => (
              <div key={i} className="tiny" style={{ color: 'var(--mauve)' }}>
                <strong>{w.title}:</strong> {w.detail}
              </div>
            ))}
          </div>
          <Button
            title={warnings ? 'Add this person anyway' : person ? "Save changes to this person's details" : 'Create this new person'}
            onClick={save}
            disabled={saving || !form.name.trim() || !isCompletePhone(form.phone)}
          >
            {saving ? 'Saving…' : warnings ? 'Add anyway' : person ? 'Save changes' : 'Add person'}
          </Button>
        </div>
      </div>
      {addingPlace && (
        <PlaceModal
          categories={categories}
          onClose={() => setAddingPlace(false)}
          onSaved={(newPlace) => {
            setExtraPlaces((eps) => [...eps, newPlace]);
            setForm((f) => ({ ...f, place_id: newPlace.id }));
          }}
          onCategoriesChanged={onCategoriesChanged}
        />
      )}
    </div>
  );
}
