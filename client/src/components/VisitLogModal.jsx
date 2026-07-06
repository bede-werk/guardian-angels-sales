import React, { useState } from 'react';
import { api, OUTCOME_LABELS } from '../api';

// Modal for logging/updating a visit: outcome, notes, key contact, next visit date.
// `visit` may be a scheduled stop (has visit_id) or, when opened from a partner with
// no scheduled visit, `partnerId` is provided to create an ad-hoc visit.
export default function VisitLogModal({ visit, partnerId, partnerName, onClose, onSaved }) {
  const [form, setForm] = useState({
    outcome: visit?.outcome || '',
    notes: visit?.notes || '',
    contact_name: visit?.contact_name || '',
    contact_title: visit?.contact_title || '',
    contact_email: visit?.contact_email || '',
    contact_phone: visit?.contact_phone || '',
    next_visit_date: visit?.next_visit_date || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const title = partnerName || visit?.name || visit?.partner_name || 'Visit';

  async function save(markComplete) {
    setSaving(true);
    setError(null);
    try {
      const payload = { ...form };
      if (markComplete) payload.status = 'completed';
      let saved;
      if (visit?.visit_id) {
        saved = await api.updateVisit(visit.visit_id, payload);
      } else {
        saved = await api.createVisit({ partner_id: partnerId, scheduled_date: new Date().toISOString().slice(0, 10), ...payload });
      }
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Log visit — {title}</h2>
          <button className="close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          <div>
            <label className="field">Outcome</label>
            <div className="outcome-group">
              {Object.entries(OUTCOME_LABELS).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  className={`outcome-btn ${form.outcome === val ? 'active' : ''}`}
                  onClick={() => setForm((f) => ({ ...f, outcome: f.outcome === val ? '' : val }))}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="field">Notes</label>
            <textarea rows={3} value={form.notes} onChange={set('notes')} placeholder="What happened, next steps…" />
          </div>

          <div className="row">
            <div>
              <label className="field">Contact name</label>
              <input value={form.contact_name} onChange={set('contact_name')} />
            </div>
            <div>
              <label className="field">Title</label>
              <input value={form.contact_title} onChange={set('contact_title')} />
            </div>
          </div>
          <div className="row">
            <div>
              <label className="field">Email</label>
              <input type="email" value={form.contact_email} onChange={set('contact_email')} />
            </div>
            <div>
              <label className="field">Phone</label>
              <input value={form.contact_phone} onChange={set('contact_phone')} />
            </div>
          </div>

          <div style={{ maxWidth: 220 }}>
            <label className="field">Next visit date</label>
            <input type="date" value={form.next_visit_date || ''} onChange={set('next_visit_date')} />
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn secondary" onClick={() => save(false)} disabled={saving}>
            Save
          </button>
          <button className="btn" onClick={() => save(true)} disabled={saving}>
            {saving ? 'Saving…' : 'Save & mark complete'}
          </button>
        </div>
      </div>
    </div>
  );
}
