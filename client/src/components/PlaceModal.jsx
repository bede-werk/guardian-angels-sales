import React, { useId, useState } from 'react';
import { api, capacityRatingKey, capacitySeedChoices, CAPACITY_RATING_KEYS, CAPACITY_RATING_LABELS, CAPACITY_RATING_HINTS } from '../api';
import Button from './ui/Button';
import PhoneInput, { isCompletePhone } from './ui/PhoneInput';
import ConfirmDialog from './ui/ConfirmDialog';
import CategoriesModal from './CategoriesModal';
import { runPreSaveCheck } from '../hooks/usePreSaveCheck';
import useClosingTransition from '../hooks/useClosingTransition';
import { useTunables } from '../hooks/useTunables';

// The category select's last option is a sentinel that opens the manage-
// categories modal instead of actually picking a category - same pattern as
// the category filter dropdowns' "Manage categories…" entry (People.jsx/
// Places.jsx). Picking it never touches form.category, so the select just
// reverts to showing whatever was already selected once the modal closes.
const MANAGE_CATEGORIES_OPTION = '__manage_categories__';

// Create or edit a place (organization). `place` present = editing (form is
// pre-filled from it); absent = creating a brand-new one from a blank form.
// Opened from Places.jsx's "Add place" button, PlaceDetail.jsx's "Edit"
// button, or PersonModal.jsx's inline "add a new place" picker.
// `onCategoriesChanged` lets the caller refresh its own category list after
// a category is added/renamed/retired from here - PlaceModal doesn't own
// that list itself, it just receives `categories` as a prop.
export default function PlaceModal({ place, categories = [], onClose, onSaved, onCategoriesChanged }) {
  const { closing, requestClose } = useClosingTransition(onClose);
  const [managingCategories, setManagingCategories] = useState(false);
  // Stable per-instance id prefix so every label.field below can pair with
  // its input via htmlFor/id - tapping a label now actually focuses the
  // field it names, on top of just visually captioning it.
  const uid = useId();
  // The rating choices' current referrals/month values - Settings-editable,
  // so they're read live rather than hardcoded here (SETTINGS_PAGE.md's rule).
  const seedChoices = capacitySeedChoices(useTunables());
  // category must be one of the categories table's values (see
  // routes/categories.js) - include the place's own current value
  // defensively even if it somehow isn't in the list (e.g. a category was
  // just retired), so editing never silently discards it.
  const categoryOptions = place?.category && !categories.includes(place.category)
    ? [place.category, ...categories]
    : categories;

  const [form, setForm] = useState({
    name: place?.name || '',
    category: place?.category || '',
    // The capacity rating, stored as its choice KEY here and converted to a
    // referrals/month number on save. '' means unrated, which is a real
    // answer - the place falls back to the category guess - and is the
    // default for a new place rather than assuming the lowest rating.
    capacity_rating: capacityRatingKey(place?.capacity_seed, seedChoices) || '',
    is_all_star: !!place?.is_all_star,
    address: place?.address || '',
    city: place?.city || '',
    state: place?.state || 'NE',
    zip: place?.zip || '',
    phone: place?.phone || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [confirmPrompt, setConfirmPrompt] = useState(null); // { message, onConfirm } | null - see ConfirmDialog

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleCategoryChange = (e) => {
    if (e.target.value === MANAGE_CATEGORIES_OPTION) { setManagingCategories(true); return; }
    set('category')(e);
  };

  // The form holds the rating as its choice KEY (stable, readable, safe to
  // compare); the API takes referrals/month. Convert at the boundary rather
  // than storing the number in form state, so a Settings change mid-edit
  // can't leave a stale number sitting in the form.
  function toPayload(extra = {}) {
    const { capacity_rating, ...rest } = form;
    return { ...rest, capacity_seed: capacity_rating ? seedChoices[capacity_rating] : null, ...extra };
  }

  // One save attempt against the API. Returns 'ok' or 'failed' ('error' is
  // already set in the latter case). `confirm_address` is always sent true
  // here since, by the time this runs, save() has already resolved any
  // address warning up front - this is just a safety-net re-check on the
  // server, not expected to fire in normal use.
  async function attemptSave(body) {
    setSaving(true);
    setError(null);
    try {
      const saved = place ? await api.updatePlace(place.id, body) : await api.createPlace(body);
      onSaved?.(saved);
      requestClose();
      return 'ok';
    } catch (e) {
      setError(e.message);
      return 'failed';
    } finally {
      setSaving(false);
    }
  }

  // Checks duplicates (by name OR address - routes/places.js's check-duplicate,
  // a dedicated endpoint, not the general list `search`) and address-validity
  // together *before* saving - both fetched fresh right here (never from a
  // debounced background hook, which could still be mid-flight and stale at
  // the moment of clicking) - so if both are a problem the rep sees one
  // combined pop-up instead of missing one. Only warn on duplicates when
  // creating - editing an existing place will always "match" itself. Pops up
  // only when "Add place"/"Save changes" is actually clicked, not while
  // still typing.
  async function save() {
    if (!isCompletePhone(form.phone)) {
      setError('Phone must be a complete number, e.g. (402) 555-1234');
      return;
    }

    const result = await runPreSaveCheck(setSaving, setError, () => Promise.all([
      !place && (form.name.trim().length >= 3 || form.address.trim())
        ? api.checkDuplicatePlace({ name: form.name.trim(), address: form.address.trim() })
        : [],
      form.address || form.city || form.zip
        ? api.checkAddress({ address: form.address, city: form.city, state: form.state, zip: form.zip })
        : { recognized: true },
    ]));
    if (!result.ok) return;
    const [duplicates, addressCheck] = result.value;

    const issues = [];
    if (duplicates.length > 0) {
      const names = duplicates.slice(0, 5).map((m) => m.name).join(', ');
      issues.push({ title: 'Possible duplicate', detail: `A similar place may already be on file: ${names}.` });
    }
    if (!addressCheck.recognized) {
      issues.push({ title: 'Unrecognized address', detail: "This address wasn't recognized." });
    }

    if (issues.length > 0) {
      setConfirmPrompt({
        issues,
        onConfirm: () => { setConfirmPrompt(null); attemptSave(toPayload({ confirm_address: true })); },
      });
      return;
    }
    attemptSave(toPayload());
  }

  return (
    <div className={`modal-backdrop${closing ? " closing" : ""}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{place ? 'Edit place' : 'Add a place'}</h2>
          <button className="close" title="Close without saving" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          <div>
            <label className="field" htmlFor={`${uid}-name`}>Organization name</label>
            <input id={`${uid}-name`} value={form.name} onChange={set('name')} autoFocus />
          </div>

          <div className="row">
            <div>
              <label className="field" htmlFor={`${uid}-category`}>Category</label>
              <select id={`${uid}-category`} value={form.category} onChange={handleCategoryChange}>
                <option value="">None</option>
                <option value={MANAGE_CATEGORIES_OPTION}>Manage categories…</option>
                <option disabled>──────────</option>
                {categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="field" htmlFor={`${uid}-capacity`}>Referral capacity</label>
              <select id={`${uid}-capacity`} value={form.capacity_rating} onChange={set('capacity_rating')}>
                <option value="">Not rated yet</option>
                {CAPACITY_RATING_KEYS.map((k) => (
                  <option key={k} value={k}>{CAPACITY_RATING_LABELS[k]}</option>
                ))}
              </select>
            </div>
          </div>

          <p className="tiny muted" style={{ marginTop: -4 }}>
            {form.capacity_rating
              ? CAPACITY_RATING_HINTS[form.capacity_rating]
              : 'Your best guess at how much business this place could send, to anyone. Leave it unrated and the planner falls back to guessing from the category.'}
          </p>

          {/* No count shown here on purpose - this form edits ONE place and
              has no view of the book. The scarcity counter lives on the Rate
              capacity screen, which is where all-stars are actually managed
              against each other. */}
          <label className="tiny" htmlFor={`${uid}-all-star`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              id={`${uid}-all-star`}
              type="checkbox"
              style={{ width: 'auto' }}
              checked={form.is_all_star}
              onChange={() => setForm((f) => ({ ...f, is_all_star: !f.is_all_star }))}
            />
            ★ All-star — one of the handful of places that matter most
          </label>

          <div>
            <label className="field" htmlFor={`${uid}-address`}>Address</label>
            <input id={`${uid}-address`} value={form.address} onChange={set('address')} />
          </div>

          <div className="row">
            <div>
              <label className="field" htmlFor={`${uid}-city`}>City</label>
              <input id={`${uid}-city`} value={form.city} onChange={set('city')} />
            </div>
            <div style={{ maxWidth: 100 }}>
              <label className="field" htmlFor={`${uid}-state`}>State</label>
              <input id={`${uid}-state`} value={form.state} onChange={set('state')} />
            </div>
            <div style={{ maxWidth: 140 }}>
              <label className="field" htmlFor={`${uid}-zip`}>Zip</label>
              <input id={`${uid}-zip`} value={form.zip} onChange={set('zip')} />
            </div>
          </div>

          <div>
            <label className="field" htmlFor={`${uid}-phone`}>Phone</label>
            <PhoneInput id={`${uid}-phone`} value={form.phone} onChange={(v) => setForm((f) => ({ ...f, phone: v }))} />
          </div>
        </div>
        <div className="modal-foot">
          <Button
            title={place ? "Save changes to this place's details" : 'Create this new place'}
            onClick={save}
            disabled={saving || !form.name.trim() || !isCompletePhone(form.phone)}
          >
            {saving ? 'Saving…' : place ? 'Save changes' : 'Add place'}
          </Button>
        </div>
        {confirmPrompt && (
          <ConfirmDialog
            issues={confirmPrompt.issues}
            onConfirm={confirmPrompt.onConfirm}
            onCancel={() => setConfirmPrompt(null)}
          />
        )}
      </div>
      {managingCategories && (
        <CategoriesModal onClose={() => setManagingCategories(false)} onChanged={onCategoriesChanged} />
      )}
    </div>
  );
}
