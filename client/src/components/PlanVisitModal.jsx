import React, { useState } from 'react';
import { api, today, formatDate } from '../api';
import Button from './ui/Button';
import PlacePicker from './ui/PlacePicker';

// Manual Visit Planning (spec §3) — "I'm going to Tabitha on Thursday," said
// directly, no route-planner draft involved. Two entry points, each with one
// side already fixed:
//   - PlaceDetail.jsx's "Plan…" button: the PLACE is fixed (`placeId`/
//     `placeName`), so the form only asks for date/rep/notes.
//   - DayOverflowModal.jsx's "Plan a visit…" button (the calendar day
//     drill-down): the DATE is fixed (`date`), so the form asks for
//     place/rep/notes instead, via PlacePicker.
// Both used to be inline toggle-reveals-a-row-of-inputs forms crammed into
// their host card/popover; pulled into one shared modal since both read as
// too cramped, especially DayOverflowModal's — its popover had to
// recompute its own on-screen position every time the form grew a field.
//
// A 200 response with no visit means the server found a §4.2 warning
// (recently visited nearby, or do_not_visit) and wants confirmation before
// writing anything; the form stays open with that warning shown, and the
// NEXT save resends with force:true. A thrown error (§4.1 hard block, or bad
// input) surfaces as an inline banner — same convention VisitLogModal/
// ReferralModal use, not a window.alert.
export default function PlanVisitModal({ placeId, placeName, date: fixedDate, userId, users, onClose, onSaved }) {
  const [pickedPlace, setPickedPlace] = useState(null);
  const [date, setDate] = useState(fixedDate || '');
  const [assignedUserId, setAssignedUserId] = useState(String(userId));
  const [notes, setNotes] = useState('');
  const [warnings, setWarnings] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const resolvedPlaceId = placeId ?? pickedPlace?.id;
  const resolvedPlaceName = placeName ?? pickedPlace?.name;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const result = await api.planVisit({
        place_id: resolvedPlaceId,
        scheduled_date: date,
        user_id: assignedUserId || userId,
        notes: notes.trim() || null,
        force: warnings ? true : undefined,
      });
      if (result && result.warnings) {
        setWarnings(result.warnings);
        return;
      }
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      // Stops the mousedown here too, not just the click above — DayOverflowModal
      // (the calendar day drill-down this modal can open from) closes itself on
      // any document-level mousedown outside its own popover; without this, a
      // click anywhere in this modal would bubble past it and close the popover
      // out from under it.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Plan a Visit{resolvedPlaceName ? ` — ${resolvedPlaceName}` : ''}</h2>
          <button className="close" title="Close without saving" onClick={onClose}>×</button>
        </div>
        <div className="modal-body stack">
          {error && <div className="error-banner">{error}</div>}

          <div>
            <label className="field">Place</label>
            {placeId ? (
              <div className="tiny"><strong>{placeName}</strong></div>
            ) : pickedPlace ? (
              <div className="tag-list" style={{ alignItems: 'center' }}>
                <span className="tiny" style={{ fontWeight: 600 }}>{pickedPlace.name}</span>
                <Button
                  variant="ghost"
                  size="small"
                  disabled={saving}
                  onClick={() => { setPickedPlace(null); setWarnings(null); setError(null); }}
                >
                  Change
                </Button>
              </div>
            ) : (
              <PlacePicker autoFocus onPick={(p) => { setPickedPlace(p); setWarnings(null); setError(null); }} />
            )}
          </div>

          <div>
            <label className="field">Date</label>
            {fixedDate ? (
              <div className="tiny"><strong>{formatDate(fixedDate)}</strong></div>
            ) : (
              <input
                type="date"
                value={date}
                min={today()}
                onChange={(e) => { setDate(e.target.value); setWarnings(null); setError(null); }}
                disabled={saving}
                autoFocus={!!placeId}
              />
            )}
          </div>

          <div>
            <label className="field">Rep</label>
            <select
              value={assignedUserId}
              onChange={(e) => { setAssignedUserId(e.target.value); setWarnings(null); setError(null); }}
              disabled={saving}
              title="Who this visit is for — any rep may plan for any other rep"
            >
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.id === userId ? `${u.name} (me)` : u.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="field">Notes</label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={saving}
              placeholder="Optional — shows up on the visit once it's planned"
            />
          </div>

          {warnings?.length > 0 && (
            <div className="tiny" style={{ color: 'var(--mauve)' }}>
              {warnings.map((w) => w.message).join(' ')}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <Button variant="secondary" title="Close without saving" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || !date || !resolvedPlaceId}>
            {saving ? 'Saving…' : warnings ? 'Plan anyway' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}
