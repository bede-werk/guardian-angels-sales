// One-time (but re-runnable) relationship seeding.
//
// WHY THIS EXISTS: on the day computed relationship shipped, no visit carried
// the met-with/outcome data the model scores against, so every place would
// have read 'weak' - including places where a real, valuable relationship
// exists. Weak + high capacity is a 7-day cadence, so the route planner would
// have demanded visits everywhere at once. Seeding encodes what the rep
// already knows so day one is honest.
//
// A seed is NOT a permanent override. It's a converged score value that
// decays on the same clock as real visit weight, so it washes out on its own
// (~3% of original after five months on a 30-day category) with no expiry
// logic and nothing to clean up. A real relationship gets visited and earns
// genuine score as the seed fades; an optimistic seed that's never followed up
// decays to nothing, which is the honest answer. A seed is a claim with an
// expiration date attached; an override is a claim that is silently wrong
// forever.
//
// Re-runnable on purpose: re-seeding a person overwrites their value AND
// resets the decay clock (server-side - see routes/people.js), which is the
// intended way to correct a seed you got wrong.
import React, { useEffect, useMemo, useState } from 'react';
import { api, formatDate, today, RELATIONSHIP_LABELS } from '../api';
import Button from './ui/Button';
import useClosingTransition from '../hooks/useClosingTransition';
import { useTunables } from '../hooks/useTunables';

// Converged SCORE values, not buckets - see services/relationship.js's
// thresholds (RELATIONSHIP_THRESHOLDS.strong/.medium, now a Settings-page
// tunable - see previewLevel below for why this component can't just
// hardcode a fixed bucket mapping the way it used to). 4.0 lands a person's
// place solidly in strong AT THE SHIPPED DEFAULTS; 2.0 in medium; 0.8 is
// deliberately below the medium default, so an acquaintance reads weak-ish
// rather than promoting a place on its own. If those defaults are retuned
// from the Settings page far enough, a choice's real landing bucket can
// shift too - that's a genuine consequence of retuning the algorithm, not a
// bug, and it's exactly why the preview below reads the LIVE thresholds
// instead of repeating this comment's assumption as fact.
const SEED_CHOICES = [
  { value: 4.0, label: 'Champion', hint: 'Knows me, sends business, I could call them' },
  { value: 2.0, label: 'Solid', hint: 'Real working relationship' },
  { value: 0.8, label: 'Acquaintance', hint: "We've met, they'd recognize me" },
];

// The row's "Relationship status" reflects the server-computed level, which
// only changes after a save round-trip. While a choice is only pending (not
// saved yet), this stands in as a preview - not a live recompute (that needs
// the person's real visit history, which this screen never fetches), just an
// honest best guess at where it's headed. Mirrors services/relationship.js's
// levelForScore exactly (score >= strong -> strong, score >= medium ->
// medium, else weak), fed the LIVE threshold values via useTunables below -
// a hardcoded bucket map here would silently go wrong the moment someone
// retunes RELATIONSHIP_THRESHOLDS from the Settings page, since this
// screen's preview would keep assuming the shipped defaults forever while
// the server (and this same screen, post-save) used the real ones.
function previewLevel(score, thresholds) {
  if (score >= thresholds.strong) return 'strong';
  if (score >= thresholds.medium) return 'medium';
  return 'weak';
}

// Same colors as the RelationshipChip badge (see styles.css's .badge.rel-*),
// just the text half - this line is plain text, not a pill.
const RELATIONSHIP_TEXT_COLOR = { strong: 'var(--teal-dark)', medium: 'var(--blue)', weak: 'var(--muted)' };

export default function SeedRelationshipsModal({ onClose, onSaved }) {
  const { closing, requestClose } = useClosingTransition(onClose);
  const tunables = useTunables();
  const thresholds = {
    strong: tunables['relationship.RELATIONSHIP_THRESHOLDS.strong'],
    medium: tunables['relationship.RELATIONSHIP_THRESHOLDS.medium'],
  };
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  // person_id -> seed value (or null to clear). Only people the user actually
  // touched land here, so an untouched person is never written at all -
  // "skippable" in the real sense, not "silently defaulted to something."
  const [pending, setPending] = useState({});
  // person_id's currently showing the three-choice picker instead of their
  // status line. A Set (not a single id) so nothing stops more than one row
  // being open at once - there's no reason to force reps through one at a
  // time when working down a place's whole roster.
  const [editingIds, setEditingIds] = useState(() => new Set());

  useEffect(() => {
    api.people
      .list({})
      .then(setPeople)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Current value for a row: the pending edit if there is one, else whatever
  // is already saved on the person.
  function currentSeed(person) {
    return Object.prototype.hasOwnProperty.call(pending, person.id) ? pending[person.id] : person.relationship_seed;
  }

  function choose(person, value) {
    setPending((p) => {
      const next = { ...p };
      // Clicking the already-selected choice clears it back to "no read."
      const picked = currentSeed(person) === value ? null : value;
      // changeCount (below) is a running total of REAL changes, so landing
      // back on whatever's already saved - by picking it directly, or by
      // toggling through choices back to it - has to drop the pending entry
      // entirely rather than just setting it to the same value. Leaving a
      // no-op entry in `pending` is exactly what made the footer keep saying
      // "Save 1 rating" after a rep deselected a fresh pick back to nothing.
      if (picked === person.relationship_seed) delete next[person.id];
      else next[person.id] = picked;
      return next;
    });
    // Deliberately does NOT close the picker - a rep can try a choice, see it
    // highlighted, and change their mind without reopening. Clicking the row
    // itself just hides the picker again (stopEditing), keeping whatever's
    // pending; only Cancel/Reset below actually touch the pending value.
  }

  // A saved seed that's never had a real visit to fade into is stale by
  // construction - it's the whole "guess" side of the score with nothing
  // real behind it yet (see this file's header on seed vs. visit weight).
  // Offering Reset here, in place of Cancel, is how a rep undoes a seed they
  // no longer stand behind rather than leaving it to decay on its own.
  function canReset(person) {
    return person.relationship_seed != null && !person.last_visit_date;
  }

  function reset(person) {
    setPending((p) => ({ ...p, [person.id]: null }));
    stopEditing(person.id);
  }

  function startEditing(id) {
    setEditingIds((prev) => new Set(prev).add(id));
  }

  function stopEditing(id) {
    setEditingIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  // Cancel = back out of THIS editing session entirely, discarding whatever
  // was picked before backing out - unlike stopEditing (used when the row
  // itself is clicked to hide the picker), which just hides it and leaves
  // any pending pick in place. Reset is the opposite of Cancel: a deliberate,
  // kept choice - see reset() above.
  function cancelEdit(id) {
    setPending((p) => {
      if (!Object.prototype.hasOwnProperty.call(p, id)) return p;
      const next = { ...p };
      delete next[id];
      return next;
    });
    stopEditing(id);
  }

  // What the status line + "last rated" label show for a row. Pending (this
  // session, unsaved) takes priority over whatever's already on the person -
  // see previewLevel above for why the status half is only a preview.
  // `level` is the raw bucket key (for color), `status` its display label.
  function rowDisplay(person) {
    if (!Object.prototype.hasOwnProperty.call(pending, person.id)) {
      const level = person.relationship_level;
      return {
        level,
        status: RELATIONSHIP_LABELS[level] || level,
        ratedAt: person.relationship_seeded_at ? formatDate(person.relationship_seeded_at) : 'Never rated',
      };
    }
    const value = pending[person.id];
    if (value == null) {
      return { level: 'weak', status: RELATIONSHIP_LABELS.weak, ratedAt: 'Never rated' };
    }
    const level = previewLevel(value, thresholds);
    return { level, status: RELATIONSHIP_LABELS[level], ratedAt: formatDate(today()) };
  }

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    // Once a person has a real completed visit, the algorithm has genuine
    // signal to score them on - the whole reason this screen exists (see the
    // file header) no longer applies, so they drop off the list entirely
    // rather than sitting here alongside people who still need a first read.
    // A still-decaying seed from an earlier pass does NOT exclude them - see
    // canReset() above, which depends on exactly these people still showing.
    return people.filter((p) => {
      if (p.last_visit_date) return false;
      if (!term) return true;
      return (
        p.name.toLowerCase().includes(term) ||
        (p.place_name || '').toLowerCase().includes(term) ||
        (p.title || '').toLowerCase().includes(term)
      );
    });
  }, [people, search]);

  // Grouped by place so a rep can work down one organization at a time, which
  // is how they actually remember these relationships.
  const grouped = useMemo(() => {
    const byPlace = new Map();
    for (const p of filtered) {
      const key = p.place_name || 'Unassigned';
      if (!byPlace.has(key)) byPlace.set(key, []);
      byPlace.get(key).push(p);
    }
    return [...byPlace.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const changeCount = Object.keys(pending).length;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const entries = Object.entries(pending).map(([person_id, seed]) => ({ person_id: Number(person_id), seed }));
      await api.people.seedRelationships(entries);
      onSaved?.();
      requestClose();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <div className={`modal-backdrop${closing ? ' closing' : ''}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Rate Relationships</h2>
          <button className="close" title="Close without saving" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          <div className="tiny muted">
            Initially rate the relationships you already have. These are estimates that fade over time. Logging real visits is what makes a relationship score real.
            Skip anyone you don't have a read on.
          </div>

          <div>
            <label className="field">Search</label>
            <input placeholder="Name, title, or place…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>

          {loading ? (
            <div className="tiny muted">Loading people…</div>
          ) : grouped.length === 0 ? (
            <div className="tiny muted">No people match that search.</div>
          ) : (
            <div className="stack">
              {grouped.map(([placeName, rows]) => (
                <div key={placeName} className="stack" style={{ gap: 6 }}>
                  <div className="tiny" style={{ fontWeight: 700 }}>{placeName}</div>
                  <div>
                  {rows.map((person, i) => {
                    const seed = currentSeed(person);
                    const editing = editingIds.has(person.id);
                    const { level, status, ratedAt } = rowDisplay(person);
                    return (
                      <div
                        key={person.id}
                        className={`tag-list${saving ? '' : ' hover-row'}`}
                        style={{
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          padding: '8px 0',
                          borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                        }}
                        title={saving ? undefined : editing ? 'Click to hide the picker - your pick, if any, is kept' : 'Click to rate this relationship'}
                        onClick={saving ? undefined : () => (editing ? stopEditing(person.id) : startEditing(person.id))}
                      >
                        <span className="tiny" style={{ flex: 1, minWidth: 140 }}>
                          {person.name}
                          {!editing && (
                            <span className="muted">
                              {' '}
                              · Relationship status: <span style={{ color: RELATIONSHIP_TEXT_COLOR[level], fontWeight: 600 }}>{status}</span>
                            </span>
                          )}
                        </span>
                        {editing ? (
                          <span className="tag-list" style={{ flex: 'unset' }}>
                            {SEED_CHOICES.map((choice) => (
                              <Button
                                key={choice.value}
                                size="small"
                                variant={seed === choice.value ? 'primary' : 'secondary'}
                                title={`${choice.hint}${seed === choice.value ? ' (click again to clear)' : ''}`}
                                onClick={(e) => { e.stopPropagation(); choose(person, choice.value); }}
                                disabled={saving}
                              >
                                {choice.label}
                              </Button>
                            ))}
                            {canReset(person) ? (
                              <Button
                                variant="danger"
                                size="small"
                                title="Clear this person's rating - they'll go back to never rated"
                                onClick={(e) => { e.stopPropagation(); reset(person); }}
                                disabled={saving}
                              >
                                Reset
                              </Button>
                            ) : (
                              <Button
                                variant="secondary"
                                size="small"
                                title="Close without changing this person's rating"
                                onClick={(e) => { e.stopPropagation(); cancelEdit(person.id); }}
                                disabled={saving}
                              >
                                Cancel
                              </Button>
                            )}
                          </span>
                        ) : (
                          <span className="tiny muted" style={{ flex: 'unset' }}>Last rated: {ratedAt}</span>
                        )}
                      </div>
                    );
                  })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <Button
            title={changeCount ? `Save ${changeCount} rating${changeCount === 1 ? '' : 's'}` : 'Rate at least one person first'}
            onClick={save}
            disabled={saving || changeCount === 0}
          >
            {saving ? 'Saving…' : changeCount ? `Save ${changeCount} rating${changeCount === 1 ? '' : 's'}` : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}
