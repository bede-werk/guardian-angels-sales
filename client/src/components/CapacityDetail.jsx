// Capacity display for PlaceDetail - capacity-computation-spec.md.
//
// Deliberately more than RelationshipDetail's short version: capacity's
// resolution (declared vs. measured vs. category-seed, override, staleness)
// has more a rep actually needs explained, and an append-only observation
// history to show - nothing here is ever overwritten (see
// capacity_observations' own migration header for why), so "how has this
// grown over time" is a real, answerable question once there's more than
// one row.
//
// All state/handlers live in the parent (PlaceDetail.jsx), same convention
// RelationshipDetail.jsx's PlaceRelationship already uses - this file is
// presentational, driven by callback props.
import React, { useEffect, useState } from 'react';
import { formatDate, CAPACITY_LABELS, isDoNotVisitActive } from '../api';
import Button from './ui/Button';
import { CapacityChip } from './ui/Chip';

const LEVELS = ['high', 'medium', 'low'];

// 'YYYY-MM-DD' -> "3 days ago" / "6 months ago" / "1 year ago" - coarse on
// purpose, this is a "does this feel current" read, not a precise clock.
function relativeAge(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const then = Date.UTC(y, m - 1, d);
  const now = Date.now();
  const days = Math.max(0, Math.round((now - then) / 86400000));
  if (days === 0) return 'today';
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (days < 365) {
    const months = Math.round(days / 30.44);
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }
  const years = Math.round(days / 365.25);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

// The one-line explanation of WHERE the effective number came from - the
// spec's own worked example ("They reported 4/month; we've received
// 9/month. Using 9.") is the 'measured' case; the other three sources each
// get their own equally plain-language line.
function sourceExplanation(capacity) {
  const { levelSource, declared, measuredFloor, effectiveMonthly } = capacity;
  if (levelSource === 'measured') {
    return declared
      ? `They reported ${declared.value}/month; we've received ${measuredFloor}/month. Using ${effectiveMonthly}.`
      : `We've received ${measuredFloor}/month - never directly asked. Using ${effectiveMonthly}.`;
  }
  if (levelSource === 'declared') {
    return 'Reported at pre-qual.'; // the count itself already shows on the chip line (~N/month)
  }
  if (levelSource === 'category_seed') {
    return 'Never pre-qualified - estimated from category.';
  }
  return null; // 'override' - the override subtext below covers this instead
}

// The single muted line under the chip - same "one plain-language line, no
// more" shape as RelationshipDetail.jsx's placeSummary, so the two cards
// read the same way at a glance. Folds staleness and the override reason
// into that one line rather than stacking extra lines underneath it (the
// old layout could show "Never pre-qualified - estimated from category."
// AND a separate "Never pre-qualified." line for the same place - this
// replaces both with one sentence per case).
function capacitySummary(capacity) {
  const { confidence, declared, isOverridden, override } = capacity;
  if (isOverridden) return `Manually set${override.reason ? ` - ${override.reason}` : ''}`;
  const base = sourceExplanation(capacity) || 'Never pre-qualified - estimated from category.';
  if (confidence === 'stale' && declared) {
    return `${base} Last confirmed ${relativeAge(declared.observedAt)} - worth asking again.`;
  }
  return base;
}

function ObservationRow({ obs }) {
  return (
    <div className="tiny" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span>
        <strong>{obs.monthly_referrals}/month</strong> · {formatDate(obs.observed_at)}
        {obs.person_name ? ` · ${obs.person_name}` : ''}
      </span>
      <span className="muted">{obs.source}</span>
    </div>
  );
}

export function PlaceCapacity({
  place,
  capacity,
  observations,
  onSaveOverride,
  savingOverride,
  onAddObservation,
  savingObservation,
  addingObservation,
  setAddingObservation,
  onEditingOverrideChange,
  onMarkDoNotVisit,
}) {
  const [editingOverride, setEditingOverride] = useState(false);
  const [overrideDraft, setOverrideDraft] = useState('');
  const [overrideReasonDraft, setOverrideReasonDraft] = useState('');
  const [observationDraft, setObservationDraft] = useState('');
  const [dnvDismissed, setDnvDismissed] = useState(false);

  // The trigger button now lives in PlaceDetail.jsx's card-head, so this
  // component only ever sees addingObservation flip to true - reset the
  // draft on that transition the same way the old inline trigger's onClick
  // used to.
  useEffect(() => {
    if (addingObservation) setObservationDraft('');
  }, [addingObservation]);

  // editingOverride itself stays local (still triggered by clicking the chip,
  // not a header button) - this just lets the header know to hide the
  // pre-qualification trigger while it's open, so that button never sits
  // there looking clickable with nowhere to show its form.
  useEffect(() => {
    onEditingOverrideChange?.(editingOverride);
  }, [editingOverride]);

  if (!capacity) return null;
  const { level, computedLevel, isOverridden, override, effectiveMonthly } = capacity;

  function startOverrideEdit() {
    setOverrideDraft(override?.level || computedLevel || '');
    setOverrideReasonDraft(override?.reason || '');
    setEditingOverride(true);
  }

  async function commitOverride(level) {
    const ok = await onSaveOverride(level, level ? overrideReasonDraft : null);
    if (ok !== false) setEditingOverride(false);
  }

  async function commitObservation() {
    const ok = await onAddObservation(observationDraft);
    if (ok !== false) {
      setAddingObservation(false);
      setObservationDraft('');
    }
  }

  return (
    <div className="stack">
      <div className="tag-list" style={{ alignItems: 'center' }}>
        <span className="tiny muted">Capacity:</span>
        {editingOverride ? null : (
          <div className="hover-row" title="Click to override the computed capacity level" onClick={startOverrideEdit} style={{ width: 'fit-content' }}>
            <CapacityChip level={level} overridden={isOverridden} />
          </div>
        )}
        {effectiveMonthly != null && !editingOverride && <span className="tiny muted">~{effectiveMonthly}/month</span>}
      </div>

      {editingOverride ? (
        <div className="stack">
          <div className="tag-list" style={{ alignItems: 'center' }}>
            <select value={overrideDraft} style={{ width: 120 }} onChange={(e) => setOverrideDraft(e.target.value)} autoFocus>
              {LEVELS.map((l) => (
                <option key={l} value={l}>{CAPACITY_LABELS[l]}</option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Why override? (optional)"
              style={{ flex: 1, minWidth: 140 }}
              value={overrideReasonDraft}
              onChange={(e) => setOverrideReasonDraft(e.target.value)}
            />
          </div>
          <div className="tag-list">
            <Button size="small" title="Override the computed capacity level" onClick={() => commitOverride(overrideDraft)} disabled={savingOverride || !overrideDraft}>
              {savingOverride ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="secondary" size="small" title="Discard without saving" onClick={() => setEditingOverride(false)} disabled={savingOverride}>
              Cancel
            </Button>
            {isOverridden && (
              <Button variant="danger" size="small" title="Remove the manual override and go back to the computed level" onClick={() => commitOverride(null)} disabled={savingOverride}>
                Use computed
              </Button>
            )}
          </div>
          <div className="tiny muted">Computed: {CAPACITY_LABELS[computedLevel]}</div>
        </div>
      ) : (
        <div className="tiny muted">{capacitySummary(capacity)}</div>
      )}

      {!editingOverride && addingObservation && (
        <div className="tag-list" style={{ alignItems: 'center' }}>
          <input
            type="number"
            min="0"
            step="1"
            placeholder="Referrals/month"
            style={{ width: 120 }}
            value={observationDraft}
            onChange={(e) => setObservationDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitObservation(); } }}
            autoFocus
          />
          <Button size="small" title="Record this pre-qualification answer" onClick={commitObservation} disabled={savingObservation || observationDraft === ''}>
            {savingObservation ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="secondary" size="small" title="Discard without saving" onClick={() => setAddingObservation(false)} disabled={savingObservation}>
            Cancel
          </Button>
        </div>
      )}

      {/* Dismissible, session-only (see the spec's own "a 0 today is a 0
          under this DON" - the suggestion re-appears on next load rather
          than remembering a permanent dismissal, since nothing about the
          underlying number changed). */}
      {effectiveMonthly === 0 && !isDoNotVisitActive(place) && !dnvDismissed && (
        <div className="tiny" style={{ background: 'var(--mauve-tint-1)', color: 'var(--mauve)', padding: '6px 10px', borderRadius: 'var(--radius-sm)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span>This place reports no winnable referrals. Mark as do-not-visit?</span>
          <span className="tag-list" style={{ flex: 'unset' }}>
            <Button size="small" variant="danger" title="Stop proposing this place in the route planner" onClick={onMarkDoNotVisit}>
              Mark
            </Button>
            <Button size="small" variant="secondary" title="Dismiss for now" onClick={() => setDnvDismissed(true)}>
              Dismiss
            </Button>
          </span>
        </div>
      )}

      {observations && observations.length > 0 && (
        <div className="stack" style={{ gap: 4, marginTop: 4 }}>
          <div className="tiny muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.02em' }}>History</div>
          {observations.map((obs) => <ObservationRow key={obs.id} obs={obs} />)}
        </div>
      )}
    </div>
  );
}
