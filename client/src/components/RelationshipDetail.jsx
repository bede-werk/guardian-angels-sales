// Relationship display for PlaceDetail / PersonDetail.
//
// Relationship level is computed, never stored (server/src/services/
// relationship.js). The whole reason these components show COMPONENTS and
// CONTRIBUTORS rather than just a grade is that a rep asking "why is this
// place weak?" has to get a real answer ("last meaningful visit 94 days ago,
// one known contact") instead of an opaque letter. A score nobody can
// interrogate is a score nobody trusts.
import React, { useState } from 'react';
import { RELATIONSHIP_LABELS, formatDate } from '../api';
import Button from './ui/Button';
import { RelationshipChip } from './ui/Chip';

const LEVELS = ['strong', 'medium', 'weak'];

// A seed is a rep's one-time judgment of an existing relationship, which then
// decays on the same clock as real visit weight (see migration
// 20260803000001). Surfacing HOW MUCH of a score is still seed is what keeps
// it honest: it says "this is provisional, and visiting is what makes it
// real." Below this share it isn't worth the words.
const SEED_NOTICE_THRESHOLD = 0.1;

function seedShare(relationship) {
  if (!relationship || !relationship.score) return 0;
  return (relationship.seed_component || 0) / relationship.score;
}

// Deliberately no "fades by <month>" date: that would need the seed date AND
// the category's half-life resolved client-side, and a confidently wrong date
// is worse than an honest description of the direction.
function SeedNotice({ relationship }) {
  const share = seedShare(relationship);
  if (share <= SEED_NOTICE_THRESHOLD) return null;
  return (
    <div className="tiny muted">
      {Math.round(share * 100)}% of this is still an initial estimate — it fades over time, and real visits replace it.
    </div>
  );
}

// PLACE — includes the manual override control. An override always renders
// NEXT TO the computed value it replaces, never instead of it: an override
// that silently looks like a computed value is exactly how the old manual
// relationship field went stale without anyone noticing.
export function PlaceRelationship({ relationship, onSave, saving }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (!relationship) return null;
  const { effective_level: effective, level: computed, is_overridden: overridden, override, score, contributors } = relationship;

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
        <div className="tiny muted">Computed from visit history: {RELATIONSHIP_LABELS[computed]} ({score.toFixed(2)})</div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="tiny hover-row" title="Click to override the computed relationship level" onClick={startEdit}>
        <span className="tag-list" style={{ alignItems: 'center', gap: 6 }}>
          <span>Relationship</span>
          <RelationshipChip level={effective} overridden={overridden} />
          {!overridden && <span className="muted">({score.toFixed(2)})</span>}
        </span>
      </div>

      {/* The divergence, stated plainly. This line is the entire anti-rot
          mechanism — an override you can't see is an override that never
          gets revisited. */}
      {overridden && (
        <div className="tiny muted">
          Set manually{override?.by_name ? ` by ${override.by_name}` : ''}
          {override?.at ? ` on ${formatDate(String(override.at).slice(0, 10))}` : ''} — computed: {RELATIONSHIP_LABELS[computed]} ({score.toFixed(2)})
        </div>
      )}

      <SeedNotice relationship={relationship} />

      {contributors && contributors.length > 0 ? (
        <div className="tiny muted">
          Built from {contributors.map((c) => `${c.name} (${c.score.toFixed(2)})`).join(', ')}
          {relationship.floor_component > 0.01 ? ' + visits with no named contact' : ''}
        </div>
      ) : (
        <div className="tiny muted">No relationship history yet — no logged visits with a named contact.</div>
      )}
    </div>
  );
}

// PERSON — no override (overrides live on the place, which is what the
// scheduler actually reads). Shows the same explainability breakdown.
export function PersonRelationship({ relationship }) {
  if (!relationship) return null;
  const { level, score, last_meaningful_visit: lastMeaningful, reciprocity_multiplier: multiplier } = relationship;

  return (
    <div className="stack">
      <div className="tiny">
        <span className="tag-list" style={{ alignItems: 'center', gap: 6 }}>
          <span>Relationship</span>
          <RelationshipChip level={level} />
          <span className="muted">({score.toFixed(2)})</span>
        </span>
      </div>
      <div className="tiny muted">
        {lastMeaningful
          ? `Last meaningful visit ${formatDate(lastMeaningful)}`
          : 'No meaningful visit logged yet'}
        {multiplier > 1 ? ` · reciprocity ×${multiplier.toFixed(2)}` : ''}
      </div>
      <SeedNotice relationship={relationship} />
    </div>
  );
}
