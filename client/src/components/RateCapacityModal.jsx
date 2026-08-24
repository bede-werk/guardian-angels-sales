// The capacity rating pass - the places counterpart to
// SeedRelationshipsModal, and deliberately built to the same shape (row per
// record, click to open a picker, nothing written until Save).
//
// WHY THIS EXISTS: capacity is one of the two axes of the cadence table, and
// until 2026-08-23 it had no human input at all. A place that had never been
// pre-qualified fell through to a keyword match on its category name - "the
// word 'Church' appeared, call it low" - which governed 99% of the book. The
// rep's own read already existed in the database as tier + ★, feeding nothing
// but a tie-break, so it was migrated into places.capacity_seed and this
// screen is where it gets reviewed and kept current.
//
// HOW THIS DIFFERS FROM THE RELATIONSHIP RATER, and why:
//
// 1. A rating does NOT decay. Relationship score is a decaying quantity, so a
//    seed denominated in the same units washes out on its own. Capacity is a
//    RATE - a place that could send 10 a month doesn't become a 3-a-month
//    place because time passed - so decaying it would silently demote the
//    whole book. What expresses "this is still only a guess" is confidence:
//    a rated place stays 'unknown', stays in the planner's exploration tier,
//    and keeps getting queued for a real pre-qualification visit. The rating
//    is superseded outright the moment a place actually tells you its number.
//
// 2. Every place already has a rating (backfilled from its old tier), so this
//    is a REVIEW queue, not a blank-slate capture. The unrated filter below
//    keys off capacity_seeded_at being null, which means "inherited from the
//    spreadsheet, nobody has actually looked" - confirming a place stamps
//    that date even when the value doesn't change, which is what moves it out
//    of the queue.
//
// 3. Each choice shows which capacity level it currently lands in, computed
//    from the live thresholds rather than hardcoded. The four rating values
//    and the two thresholds are independently editable on the Settings page,
//    so the mapping between them is not a constant - printing it here is what
//    keeps that coupling visible instead of silent.
import React, { useEffect, useMemo, useState } from 'react';
import {
  api,
  formatDate,
  today,
  capacityRatingKey,
  capacitySeedChoices,
  CAPACITY_LABELS,
  CAPACITY_RATING_KEYS,
  CAPACITY_RATING_LABELS,
  CAPACITY_RATING_HINTS,
} from '../api';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import useClosingTransition from '../hooks/useClosingTransition';
import { useTunables } from '../hooks/useTunables';

// Mirrors server services/capacity.js's bucketForMonthlyReferrals exactly,
// fed the LIVE thresholds. A hardcoded bucket map here would go quietly wrong
// the moment someone retunes CAPACITY_THRESHOLDS from the Settings page -
// this screen would keep promising the shipped defaults forever while the
// server used the real ones.
function previewLevel(value, thresholds) {
  if (value >= thresholds.high) return 'high';
  if (value >= thresholds.medium) return 'medium';
  return 'low';
}

// The text half of the CapacityChip colors (see styles.css's .badge.cap-*) -
// these lines are plain text, not pills.
const CAPACITY_TEXT_COLOR = { high: 'var(--teal-dark)', medium: 'var(--blue)', low: 'var(--muted)' };

export default function RateCapacityModal({ onClose, onSaved }) {
  const { closing, requestClose } = useClosingTransition(onClose);
  const tunables = useTunables();
  const seedChoices = capacitySeedChoices(tunables);
  const thresholds = {
    high: tunables['scheduling.CAPACITY_THRESHOLDS.HIGH_MIN'],
    medium: tunables['scheduling.CAPACITY_THRESHOLDS.MEDIUM_MIN'],
  };

  const [places, setPlaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  // Defaults to the review queue - the whole point of the screen is working
  // through what nobody has confirmed yet.
  const [unratedOnly, setUnratedOnly] = useState(true);
  // place_id -> seed value (or null to clear). Only places actually touched
  // land here, so an untouched place is never written - "skippable" in the
  // real sense, not "silently defaulted to something."
  const [pending, setPending] = useState({});
  // place_id -> boolean. Separate from `pending` because the two answer
  // different questions and either can be changed without the other: capacity
  // is "how much do they send," all-star is "does this one outrank its own
  // volume." Merging them into a single pending map would make "I only
  // toggled the star" indistinguishable from "I re-confirmed the rating."
  const [pendingStars, setPendingStars] = useState({});
  const [allStarTarget, setAllStarTarget] = useState(0);
  const [editingIds, setEditingIds] = useState(() => new Set());

  useEffect(() => {
    api.places({})
      .then(setPlaces)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // The target only - the COUNT is derived live from `places` + pending
    // edits below, so it moves as you toggle rather than lagging a save.
    api.filters().then((f) => setAllStarTarget(f.allStarTarget || 0)).catch(() => {});
  }, []);

  function currentSeed(place) {
    return Object.prototype.hasOwnProperty.call(pending, place.id) ? pending[place.id] : place.capacity_seed;
  }

  function currentStar(place) {
    return Object.prototype.hasOwnProperty.call(pendingStars, place.id) ? pendingStars[place.id] : !!place.is_all_star;
  }

  function toggleStar(place) {
    setPendingStars((p) => {
      const next = { ...p };
      const picked = !currentStar(place);
      // Back to the saved value = no longer a change, so drop the entry
      // entirely rather than leaving a no-op that inflates the save count.
      if (picked === !!place.is_all_star) delete next[place.id];
      else next[place.id] = picked;
      return next;
    });
  }

  function choose(place, value) {
    setPending((p) => {
      const next = { ...p };
      // Clicking the already-selected choice clears it back to "no read."
      const picked = currentSeed(place) === value ? null : value;
      // Unlike the relationship rater, landing back on the place's SAVED
      // value is still a real change here, because saving re-stamps
      // capacity_seeded_at and that's what confirms the inherited rating. So
      // the pending entry is only dropped when the place was already
      // confirmed AND the value is unchanged - otherwise "yes, still Steady"
      // would be silently discarded as a no-op and the place would never
      // leave the review queue.
      if (picked === place.capacity_seed && place.capacity_seeded_at) delete next[place.id];
      else next[place.id] = picked;
      return next;
    });
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

  // Backs out of this editing session, discarding whatever was picked -
  // unlike stopEditing (used when the row itself is clicked), which just
  // hides the picker and keeps any pending pick.
  function cancelEdit(id) {
    const drop = (map) => {
      if (!Object.prototype.hasOwnProperty.call(map, id)) return map;
      const next = { ...map };
      delete next[id];
      return next;
    };
    setPending(drop);
    setPendingStars(drop); // Cancel backs out of the whole row, star included.
    stopEditing(id);
  }

  // What the row's status line shows. A pending pick takes priority over
  // what's saved. `level` is the raw bucket key (for color).
  function rowDisplay(place) {
    const touched = Object.prototype.hasOwnProperty.call(pending, place.id);
    const value = touched ? pending[place.id] : place.capacity_seed;
    if (value == null) {
      return {
        level: null,
        status: 'Not rated - guessing from category',
        ratedAt: 'Never rated',
      };
    }
    const key = capacityRatingKey(value, seedChoices);
    const level = previewLevel(value, thresholds);
    return {
      level,
      // A stored value matching no current choice means the Settings values
      // were retuned after this place was rated. Say so plainly rather than
      // rendering a blank - it's a real prompt to re-rate, not an error.
      status: key ? CAPACITY_RATING_LABELS[key] : `${value}/mo (no longer a choice)`,
      ratedAt: touched ? formatDate(today()) : place.capacity_seeded_at ? formatDate(place.capacity_seeded_at) : 'Never rated',
    };
  }

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return places.filter((p) => {
      // A place touched this session stays visible even once it no longer
      // matches the unrated filter - otherwise rating a place would make its
      // own row vanish mid-pass, which is disorienting and hides mistakes.
      const touched =
        Object.prototype.hasOwnProperty.call(pending, p.id) ||
        Object.prototype.hasOwnProperty.call(pendingStars, p.id);
      if (unratedOnly && p.capacity_seeded_at && !touched) return false;
      if (!term) return true;
      return p.name.toLowerCase().includes(term) || (p.category || '').toLowerCase().includes(term);
    });
  }, [places, search, unratedOnly, pending, pendingStars]);

  // Grouped by category, which is how the judgment actually gets made: a rep
  // comparing all their hospices to each other rates far more consistently
  // than one walking an alphabetical list of mixed place types.
  const grouped = useMemo(() => {
    const byCategory = new Map();
    for (const p of filtered) {
      const key = p.category || 'Uncategorized';
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key).push(p);
    }
    return [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const changeCount = Object.keys(pending).length + Object.keys(pendingStars).length;
  const unratedCount = places.filter((p) => !p.capacity_seeded_at).length;
  // Counted live off pending edits, not off the server's number, so the tally
  // moves the instant a star is toggled. This visible count IS the mechanism
  // that keeps all-star scarce - see migration 20260824000000 on why the flag
  // it replaces died without one.
  const allStarCount = places.filter((p) => currentStar(p)).length;
  const overTarget = allStarTarget > 0 && allStarCount > allStarTarget;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // One entry per touched place, carrying whichever of the two fields
      // actually changed - the server treats an absent key as "leave it".
      const ids = new Set([...Object.keys(pending), ...Object.keys(pendingStars)]);
      const entries = [...ids].map((id) => {
        const entry = { place_id: Number(id) };
        if (Object.prototype.hasOwnProperty.call(pending, id)) entry.seed = pending[id];
        if (Object.prototype.hasOwnProperty.call(pendingStars, id)) entry.is_all_star = pendingStars[id];
        return entry;
      });
      await api.rateCapacity(entries);
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
          <h2>Rate Capacity</h2>
          <button className="close" title="Close without saving" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          <div className="tiny muted">
            How much business could each place send? This is an estimate standing in until a place
            actually tells you its number on a pre-qualification visit, at which point their answer replaces your rating. Ratings do not
            expire, and a rated place still gets queued for pre-qualification.
          </div>

          <div className="tag-list" style={{ alignItems: 'flex-end', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="field">Search</label>
              <input placeholder="Name or category…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <label className="tiny" style={{ display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 8 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={unratedOnly}
                onChange={(e) => setUnratedOnly(e.target.checked)}
              />
              Only ones I haven&apos;t confirmed ({unratedCount})
            </label>
          </div>

          {/* The scarcity counter. Deliberately always visible rather than
              only when over - a budget you can only see once you have blown
              it is not a budget. */}
          <div className={overTarget ? 'warn-banner' : 'tiny muted'}>
            <strong>★ {allStarCount} of {allStarTarget} all-stars</strong>
            {overTarget
              ? ` — over target. Nothing stops you, but the whole point of all-star is that it stays scarce: past ${allStarTarget} or so it starts meaning "most places" instead of "the ones that matter most."`
              : '. The handful of places that matter most.'}
          </div>

          {loading ? (
            <div className="tiny muted">Loading places…</div>
          ) : grouped.length === 0 ? (
            <EmptyState message={unratedOnly ? 'Every place has been confirmed. Untick the filter to review them again.' : 'No places match that search.'} />
          ) : (
            <div className="stack">
              {grouped.map(([category, rows]) => (
                <div key={category} className="stack" style={{ gap: 6 }}>
                  <div className="tiny" style={{ fontWeight: 700 }}>{category}</div>
                  <div>
                    {rows.map((place, i) => {
                      const seed = currentSeed(place);
                      const editing = editingIds.has(place.id);
                      const { level, status, ratedAt } = rowDisplay(place);
                      return (
                        <div
                          key={place.id}
                          className={`tag-list${saving ? '' : ' hover-row'}`}
                          style={{
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 8,
                            padding: '8px 0',
                            borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                          }}
                          title={saving ? undefined : editing ? 'Click to hide the picker - your pick, if any, is kept' : 'Click to rate this place'}
                          onClick={saving ? undefined : () => (editing ? stopEditing(place.id) : startEditing(place.id))}
                        >
                          <span className="tiny" style={{ flex: 1, minWidth: 140 }}>
                            {currentStar(place) && <span title="All-star" style={{ color: 'var(--mauve)', fontWeight: 700 }}>★ </span>}
                            {place.name}
                            {!editing && (
                              <span className="muted">
                                {' '}
                                · <span style={{ color: level ? CAPACITY_TEXT_COLOR[level] : 'var(--muted)', fontWeight: 600 }}>{status}</span>
                              </span>
                            )}
                          </span>
                          {editing ? (
                            <span className="tag-list" style={{ flex: 'unset' }}>
                              {CAPACITY_RATING_KEYS.map((key) => {
                                const value = seedChoices[key];
                                const lands = previewLevel(value, thresholds);
                                return (
                                  <Button
                                    key={key}
                                    size="small"
                                    variant={seed === value ? 'primary' : 'secondary'}
                                    title={`${CAPACITY_RATING_HINTS[key]} — about ${value}/month, which currently reads ${CAPACITY_LABELS[lands]} capacity.${seed === value ? ' Click again to clear.' : ''}`}
                                    onClick={(e) => { e.stopPropagation(); choose(place, value); }}
                                    disabled={saving}
                                  >
                                    {CAPACITY_RATING_LABELS[key]}
                                  </Button>
                                );
                              })}
                              <Button
                                size="small"
                                variant={currentStar(place) ? 'primary' : 'secondary'}
                                title={
                                  currentStar(place)
                                    ? 'Remove this place from the all-stars'
                                    : 'Mark as an all-star: one of the handful of places that matter most'
                                }
                                onClick={(e) => { e.stopPropagation(); toggleStar(place); }}
                                disabled={saving}
                              >
                                ★
                              </Button>
                              <Button
                                variant="secondary"
                                size="small"
                                title="Close without changing this place's rating"
                                onClick={(e) => { e.stopPropagation(); cancelEdit(place.id); }}
                                disabled={saving}
                              >
                                Cancel
                              </Button>
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
            title={changeCount ? `Save ${changeCount} rating${changeCount === 1 ? '' : 's'}` : 'Rate at least one place first'}
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
