import React, { useId, useState } from 'react';
import { api, today } from '../api';
import Button from './ui/Button';
import useClosingTransition from '../hooks/useClosingTransition';

// Log or edit a referral. Opened either from a place (pass `people`, its
// roster, so the form includes a picker) or from a person's own page (pass
// `person` directly, so who it's for is already fixed and no picker is
// needed). Pass `referral` to edit an existing one instead of creating a new
// one - who it's attributed to isn't editable there (delete and re-log
// instead), so `person`/`people` still just drive the read-only display.
// Every referral is attributed to a specific person - there's no "unknown
// contact" option, since a place's referral total is just the sum of its
// people's own counts (see PlaceDetail.jsx / routes/places.js), so a
// referral with no person would have nowhere to be counted. That person does
// NOT have to be assigned to a place, though - opened from a person, this
// saves fine for someone with a null place_id (routes/referrals.js explains
// what that costs).
export default function ReferralModal({ people = [], person, referral, onClose, onSaved }) {
  const { closing, requestClose } = useClosingTransition(onClose);
  // See PlaceModal's identical comment - pairs every label.field below with
  // its input via htmlFor/id.
  const uid = useId();
  const [form, setForm] = useState({
    person_id: referral?.person_id || person?.id || '',
    referral_date: referral?.referral_date || today(),
    notes: referral?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const canSave = form.person_id && form.notes.trim();

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload = { referral_date: form.referral_date || null, notes: form.notes || null };
      const saved = referral
        ? await api.referrals.update(referral.id, payload)
        : await api.referrals.create({ ...payload, person_id: form.person_id });
      onSaved?.(saved);
      requestClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`modal-backdrop${closing ? " closing" : ""}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{referral ? 'Edit referral' : 'Log a referral'}</h2>
          <button className="close" title="Close without saving" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          <div>
            <label className="field" htmlFor={`${uid}-person`}>Who referred it?</label>
            {person ? (
              <div className="tiny"><strong>{person.name}</strong></div>
            ) : (
              <select id={`${uid}-person`} value={form.person_id} onChange={set('person_id')} disabled={people.length === 0} autoFocus>
                <option value="">{people.length === 0 ? 'No one on file here yet' : 'Select a person…'}</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.title ? ` - ${p.title}` : ''}</option>
                ))}
              </select>
            )}
          </div>

          <div style={{ maxWidth: 220 }}>
            <label className="field" htmlFor={`${uid}-date`}>Date</label>
            <input id={`${uid}-date`} type="date" value={form.referral_date} onChange={set('referral_date')} />
          </div>

          <div>
            <label className="field" htmlFor={`${uid}-notes`}>Notes</label>
            <textarea id={`${uid}-notes`} rows={2} value={form.notes} onChange={set('notes')} />
          </div>
        </div>
        <div className="modal-foot">
          <Button
            title={canSave ? 'Save this referral' : 'Add a note first'}
            onClick={save}
            disabled={saving || !canSave}
          >
            {saving ? 'Saving…' : referral ? 'Save changes' : 'Log referral'}
          </Button>
        </div>
      </div>
    </div>
  );
}
