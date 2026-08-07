// Relationship display for PlaceDetail / PersonDetail.
//
// Relationship level is computed, never stored (server/src/services/
// relationship.js). This is deliberately the SHORT version — a chip plus one
// plain-language line, no raw score, no contributor breakdown. A dedicated
// relationship detail tab is planned for the full "why is this weak?"
// interrogation (components, contributors, seed share); until that exists,
// keep this surface simple and trustworthy rather than showing numbers with
// no context to interpret them by.
import React, { useState } from 'react';
import { RELATIONSHIP_LABELS } from '../api';
import Button from './ui/Button';
import { RelationshipChip } from './ui/Chip';

const LEVELS = ['strong', 'medium', 'weak'];

// A seed is a rep's one-time judgment of an existing relationship, which then
// decays on the same clock as real visit weight (see migration
// 20260803000001). Below this share, a score reads as "real" rather than
// "still mostly an initial guess" — same threshold the old detailed view used.
const SEED_MAJORITY_THRESHOLD = 0.5;

function seedShare(relationship) {
  if (!relationship || !relationship.score) return 0;
  return (relationship.seed_component || 0) / relationship.score;
}

// The trend badge — 'up' | 'down' | null from services/relationship.js
// (never computed client-side). Absent whenever the server has nothing
// meaningful to say: no history at either point, too small a move to call
// out, or a manual override in play (the override IS the answer at that
// point — see the override comment on PlaceRelationship below).
const TREND_LABEL = { up: 'Heating up', down: 'Cooling down' };
const TREND_ARROW = { up: '↑', down: '↓' };

function TrendIndicator({ trend }) {
  if (!trend) return null;
  return (
    <span className={`trend-indicator trend-${trend}`}>
      {TREND_ARROW[trend]} {TREND_LABEL[trend]}
    </span>
  );
}

// A short, plain-language line standing in for the raw score. Order matters:
// an override is the most important thing to disclose (see the anti-rot
// comment below), then whether there's any real signal at all, then whether
// that signal is still mostly a rep's initial guess rather than earned
// through visits.
function placeSummary({ is_overridden, contributors, floor_component, ...relationship }) {
  if (is_overridden) return 'Manually set';
  const hasSignal = (contributors && contributors.length > 0) || floor_component > 0.01;
  if (!hasSignal) return 'No relationship history yet';
  if (seedShare(relationship) > SEED_MAJORITY_THRESHOLD) return 'Based on an initial estimate';
  return 'Built from interactions with people at this place';
}

// PLACE — includes the manual override control. An override always renders
// NEXT TO the computed value it replaces, never instead of it: an override
// that silently looks like a computed value is exactly how the old manual
// relationship field went stale without anyone noticing.
export function PlaceRelationship({ relationship, onSave, saving }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (!relationship) return null;
  const { effective_level: effective, level: computed, is_overridden: overridden, override } = relationship;

  function startEdit() {
    setDraft(override?.level || effective || '');
    setEditing(true);
  }

  async function commit(value) {
    const ok = await onSave(value);
    if (ok !== false) setEditing(false);
  }

  if (editing) {
    return (
      <div className="stack">
        <div className="tag-list" style={{ alignItems: 'center' }}>
          <select value={draft} style={{ width: 140 }} onChange={(e) => setDraft(e.target.value)} autoFocus>
            {LEVELS.map((l) => (
              <option key={l} value={l}>{RELATIONSHIP_LABELS[l]}</option>
            ))}
          </select>
          <Button size="small" title="Override the computed relationship level" onClick={() => commit(draft)} disabled={saving || !draft}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="secondary" size="small" title="Discard without saving" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </Button>
          {overridden && (
            <Button
              variant="danger"
              size="small"
              title="Remove the manual override and go back to the computed level"
              onClick={() => commit(null)}
              disabled={saving}
            >
              Use computed
            </Button>
          )}
        </div>
        <div className="tiny muted">Computed status: {RELATIONSHIP_LABELS[computed]}</div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="tag-list" style={{ alignItems: 'center' }}>
        <span className="tiny muted">Status:</span>
        <div className="hover-row" title="Click to override the computed relationship level" onClick={startEdit} style={{ width: 'fit-content' }}>
          <RelationshipChip level={effective} overridden={overridden} />
        </div>
        <TrendIndicator trend={relationship.trend} />
      </div>
      <div className="tiny muted">{placeSummary(relationship)}</div>
    </div>
  );
}

// A short, plain-language line standing in for the raw score — same idea as
// placeSummary above, minus the override case (overrides live on the place).
function personSummary({ last_meaningful_visit: lastMeaningful, ...relationship }) {
  if (!lastMeaningful) {
    return seedShare(relationship) > SEED_MAJORITY_THRESHOLD ? 'Based on an initial estimate' : 'No relationship history yet';
  }
  return 'Built from your visits with them';
}

// PERSON — no override (overrides live on the place, which is what the
// scheduler actually reads).
export function PersonRelationship({ relationship }) {
  if (!relationship) return null;
  const { level } = relationship;

  return (
    <div className="stack">
      <div className="tag-list" style={{ alignItems: 'center' }}>
        <span className="tiny muted">Status:</span>
        <RelationshipChip level={level} />
        <TrendIndicator trend={relationship.trend} />
      </div>
      <div className="tiny muted">{personSummary(relationship)}</div>
    </div>
  );
}
