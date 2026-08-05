import React, { useEffect, useState } from 'react';
import { api, today, VISIT_TYPE_MINUTES, OUTCOME_LABELS, MET_WITH_LABELS } from '../api';
import Button from './ui/Button';
import PersonModal from './PersonModal';
import AssignPersonModal from './AssignPersonModal';

// Modal for logging a visit. All three ways in — a brand-new ad-hoc visit, a
// route-planner stop being completed, and an existing visit being corrected —
// run through the SAME form, because they're all the same question: this trip
// happened, who was on it, and what happened with each of them. There used to
// be a second, single-encounter form for the edit path; it existed only
// because one visit ROW was one person, which is no longer true (see
// migrations/20260806000000_split_visit_encounters.js). A visit is now the
// trip and its `encounters` are the people, so editing one is editing a list,
// exactly like creating one.
//
// The Date field is hidden only when the trip's status is 'planned' — a
// still-open route-planner stop, whose date is fixed to whatever the planner
// assigned it (completing it shouldn't let the date drift from the day it was
// actually scheduled for). Every other case shows it editable: a brand-new
// ad-hoc visit defaults to today, and correcting an already-completed visit's
// date is as valid a correction as its notes or its people.
//
// `visit` is passed when editing/completing an existing trip (it must carry
// visit_id); when opened from a place with no visit yet, `placeId` is provided
// instead to create a brand-new ad-hoc one (from PlaceDetail.jsx).
// `initialPerson` (id/name/…) is an optional convenience default for the
// person picker — used when opened from PersonDetail.jsx, which already knows
// who the visit is with; it's a starting selection, not a lock.
// On narrow screens this renders as a bottom slide-up sheet instead of a
// centered modal — see the @media rule for .modal-backdrop in styles.css.
//
// WHAT THIS CAPTURES AND WHY (see server/src/services/relationship.js):
// "Who did you meet" and "what happened" are both REQUIRED here, because they
// are the two axes the computed relationship score multiplies together. The
// model is only ever as good as this form — a visit logged without them is a
// visit that can't tell the difference between a real sit-down and dropping a
// brochure at a front desk. They're asked as explicit questions rather than
// inferred (e.g. from whether a person happened to be picked) precisely so a
// blank answer isn't quietly treated as a real one. Each encounter answers
// "what happened" for ITSELF: "substantive with Sharon" and "gatekept by the
// front desk" on one trip are different facts, and collapsing them to one
// answer throws away whichever is less convenient.
//
// A place that still reads capacity_status 'estimated' also gets the optional
// "avg. referrals/month discovered at pre-qual" field — not a real visits
// column, it writes through server-side to places.capacity_monthly_referrals +
// capacity_status: 'verified' (routes/visits.js's maybeCapturePreQualification).
// This used to appear only on a place's FIRST completed visit, which meant
// missing it once left that place stuck on an estimated capacity forever.
export default function VisitLogModal({ visit, placeId, placeName, initialPerson, userId, onClose, onSaved }) {
  // Whichever way this modal was opened, we need to know which place it's for.
  const resolvedPlaceId = visit?.place_id || placeId;
  const isEditing = Boolean(visit?.visit_id);

  // Trip-level facts — true of the whole visit, whoever was on it. Note
  // next_visit_date has no field in this form but is carried through the save
  // regardless: it's what puts this place in the route planner's commitment
  // tier, and dropping it from the payload would silently un-schedule a
  // promised return.
  const [form, setForm] = useState({
    scheduled_date: visit?.scheduled_date || today(),
    // visit_type is no longer asked here — it exists purely as the route
    // planner's time ESTIMATE (config/visitTypes.js), so a rep logging what
    // actually happened has nothing useful to say about it. A planned stop
    // keeps whatever the planner assigned (so estimated-vs-actual stays
    // comparable); a fresh ad-hoc visit simply has none, rather than a
    // fabricated "drop-in" that would pollute that comparison.
    visit_type: visit?.visit_type || null,
    // An already-recorded duration always wins; otherwise suggest the planned
    // minutes for the type the ROUTE PLANNER assigned, when there is one. An
    // ad-hoc visit has no planned type and so starts blank — the field is
    // optional, and a made-up default would be worse than an honest gap.
    actual_duration_minutes: visit?.actual_duration_minutes ?? VISIT_TYPE_MINUTES[visit?.visit_type] ?? '',
    notes: visit?.notes || '',
    next_visit_date: visit?.next_visit_date || '',
  });

  // --- Encounter state ----------------------------------------------------
  // The trip's people, expressed as the two pickers below (which kinds of
  // people were met, and which specific named ones) plus one answer block per
  // resulting encounter. Editing hydrates all of it from the trip's existing
  // encounters — see the fetch effect below.
  const [metTypes, setMetTypes] = useState(isEditing ? [] : ['named_person']);
  const [selectedPersonIds, setSelectedPersonIds] = useState(
    !isEditing && initialPerson?.id ? [initialPerson.id] : []
  );
  // encounter key -> { outcome, they_requested }. Keyed rather than indexed so
  // ticking/unticking someone else never shuffles answers already given.
  const [details, setDetails] = useState({});
  // encounter key -> the id of the encounter row already on file for it. The
  // server's PATCH upserts by id, so this is what makes an edit an edit —
  // see the payload comment in save().
  const [encounterIds, setEncounterIds] = useState({});
  // encounter key -> the person_name snapshotted on it. Only used to label
  // someone who's on this trip but isn't in this place's roster — either
  // because they've since moved, or because the roster hasn't come back yet,
  // which is why `initialPerson`'s own name seeds it.
  const [encounterNames, setEncounterNames] = useState(
    initialPerson?.id ? { [`person:${initialPerson.id}`]: initialPerson.name } : {}
  );
  // Encounters whose person record was deleted after the fact (person_id
  // nulled via ON DELETE SET NULL, the person_name snapshot surviving).
  // They're kept out of the picker and shown locked: re-pointing one would
  // silently reattribute that history to whoever was picked instead. They
  // still travel in the save payload, since an encounter missing from it is
  // an encounter the server deletes.
  const [lostPeople, setLostPeople] = useState([]);
  const [loadingTrip, setLoadingTrip] = useState(isEditing);
  // The trip's real status, once known — a planned stop hides the date field.
  const [status, setStatus] = useState(visit?.status);

  const [people, setPeople] = useState([]); // this place's people, for the person picker
  const [creatingPerson, setCreatingPerson] = useState(false); // "+ Create new person…" modal open?
  const [assigningPerson, setAssigningPerson] = useState(false); // "+ Assign someone already on file…" modal open?
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false); // true after a successful save — shows the confirmation screen
  // Set when the server reports a planned/completed visit already exists at
  // this place on this date — either another rep's, or this same rep's own
  // (an accidental double-log) — via routes/visits.js's collision check,
  // ad-hoc creation only. Save becomes "Save anyway" — re-submitting with
  // `force: true` — rather than silently blocking; this is a heads-up, not a
  // hard rule. Cleared whenever the date changes, since that's what the
  // collision was actually keyed on.
  const [collisionWarning, setCollisionWarning] = useState(null);
  // Fetched to know whether this place still needs pre-qualifying (see the
  // module comment). Not part of `form`: it's a transient side-channel value
  // that writes through to places.capacity_monthly_referrals server-side.
  const [place, setPlace] = useState(null);
  const [avgReferrals, setAvgReferrals] = useState('');

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const title = placeName || visit?.place_name || 'Visit';

  // Load this place's people once we know who the place is, so the person
  // picker has real options.
  useEffect(() => {
    if (!resolvedPlaceId) return;
    api.people.listForPlace(resolvedPlaceId).then(setPeople).catch(() => {});
  }, [resolvedPlaceId]);

  // Also load the place itself, to know whether it still needs pre-qualifying.
  useEffect(() => {
    if (!resolvedPlaceId) return;
    api.place(resolvedPlaceId).then(setPlace).catch(() => {});
  }, [resolvedPlaceId]);

  // Editing/completing always refetches the trip, because the lists that open
  // this modal (a place's or person's visit history) carry only a name-only
  // encounter summary — no ids, no outcomes. Saving off that summary would
  // send back encounters with no ids and delete-and-recreate every one of
  // them. GET /api/visits/:id is the only call that returns them in full.
  useEffect(() => {
    if (!isEditing) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const trip = await api.visit(visit.visit_id);
        if (cancelled) return;
        const list = trip.encounters || [];
        setStatus(trip.status);
        setForm({
          scheduled_date: trip.scheduled_date || today(),
          visit_type: trip.visit_type || null,
          actual_duration_minutes: trip.actual_duration_minutes ?? VISIT_TYPE_MINUTES[trip.visit_type] ?? '',
          notes: trip.notes || '',
          next_visit_date: trip.next_visit_date || '',
        });
        // A planned stop being completed has no encounters yet, so it starts
        // on the same default a brand-new visit gets rather than an empty
        // form the rep has to open by hand.
        setMetTypes(list.length ? [...new Set(list.map((e) => e.met_with_type).filter(Boolean))] : ['named_person']);
        setSelectedPersonIds(
          list.filter((e) => e.met_with_type === 'named_person' && e.person_id != null).map((e) => e.person_id)
        );
        setLostPeople(list.filter((e) => e.met_with_type === 'named_person' && e.person_id == null));
        const ids = {};
        const names = {};
        const answers = {};
        for (const e of list) {
          const key = encounterKey(e);
          ids[key] = e.id;
          if (e.person_name) names[key] = e.person_name;
          answers[key] = { outcome: e.outcome || '', they_requested: Boolean(e.they_requested) };
        }
        setEncounterIds(ids);
        setEncounterNames(names);
        setDetails(answers);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoadingTrip(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isEditing, visit?.visit_id]);

  // How an encounter on file maps onto one of the rows below. A named person
  // is identified by WHO they are (so unticking and re-ticking them lands back
  // on the same encounter, id intact); a category by which category; someone
  // whose record is gone can only be identified by the encounter itself.
  function encounterKey(e) {
    if (e.met_with_type !== 'named_person') return `type:${e.met_with_type}`;
    return e.person_id != null ? `person:${e.person_id}` : `lost:${e.id}`;
  }

  // Who the "Which people?" picker offers: this place's roster, plus anyone
  // already on this trip who has since been moved to another place. Without
  // that second group, editing an old visit would show them as neither
  // present nor removable while still saving them.
  const pickerPeople = [
    ...people,
    ...selectedPersonIds
      .filter((id) => !people.some((p) => p.id === id))
      .map((id) => ({ id, name: encounterNames[`person:${id}`] || 'Someone on file', title: null })),
  ];

  // The encounters this trip will save, derived from the pickers. One per
  // named person, plus one per non-named category — so "a specific person +
  // the receptionist" is two encounters, each answered separately. `id` is
  // present only for those already on file.
  const encounters = [
    ...lostPeople.map((e) => ({
      key: `lost:${e.id}`,
      id: e.id,
      met_with_type: 'named_person',
      person_id: null,
      label: `${e.person_name || 'Someone'}${e.person_title ? ` — ${e.person_title}` : ''} (no longer on file)`,
    })),
    ...(metTypes.includes('named_person')
      ? selectedPersonIds.map((id) => {
          const p = pickerPeople.find((x) => x.id === id);
          return {
            key: `person:${id}`,
            id: encounterIds[`person:${id}`],
            met_with_type: 'named_person',
            person_id: id,
            label: p ? p.name : 'Selected person',
          };
        })
      : []),
    ...metTypes
      .filter((t) => t !== 'named_person')
      .map((t) => ({
        key: `type:${t}`,
        id: encounterIds[`type:${t}`],
        met_with_type: t,
        person_id: null,
        label: MET_WITH_LABELS[t],
      })),
  ];

  const detailFor = (key) => details[key] || { outcome: '', they_requested: false };

  // Keeps appearing until a real number is captured — see the module comment.
  const needsPreQual = Boolean(place && place.capacity_status === 'estimated');

  // Every encounter has to say what happened — an unanswered one would be
  // scored at the model's unknown-outcome floor, silently under-crediting it.
  const canSave =
    !loadingTrip &&
    form.notes.trim() &&
    encounters.length > 0 &&
    encounters.every((e) => detailFor(e.key).outcome);

  // Ticking a kind of person met. "Nobody" is mutually exclusive with
  // everything else — "I met nobody AND the receptionist" is a contradiction —
  // so choosing it clears the rest, and choosing anything else clears it.
  function toggleMetType(type) {
    setMetTypes((types) => {
      if (type === 'nobody') return types.includes('nobody') ? [] : ['nobody'];
      const withoutNobody = types.filter((t) => t !== 'nobody');
      return withoutNobody.includes(type)
        ? withoutNobody.filter((t) => t !== type)
        : [...withoutNobody, type];
    });
  }

  // Per-encounter answers ("what happened" / "did they ask for anything").
  function setDetail(key, patch) {
    setDetails((d) => ({ ...d, [key]: { ...(d[key] || { outcome: '', they_requested: false }), ...patch } }));
  }

  // Tick/untick one of the place's people.
  function togglePerson(id) {
    const numericId = Number(id);
    setSelectedPersonIds((ids) =>
      ids.includes(numericId) ? ids.filter((x) => x !== numericId) : [...ids, numericId]
    );
  }

  // Someone already on file was just linked to this place. Refetch the roster
  // so they appear in the picker, then select everyone who was assigned —
  // assigning from inside a visit log almost always means "this is who I met."
  async function handlePeopleAssigned(assignedIds) {
    try {
      const roster = await api.people.listForPlace(resolvedPlaceId);
      setPeople(roster);
      if (!assignedIds || !assignedIds.length) return;
      const ids = assignedIds.map(Number).filter((id) => roster.some((x) => x.id === id));
      // Assigning someone implies you met them, so make sure the "a specific
      // person" category is ticked — otherwise they'd be selected but produce
      // no encounter.
      setMetTypes((types) => [...new Set([...types.filter((t) => t !== 'nobody'), 'named_person'])]);
      setSelectedPersonIds((prev) => [...new Set([...prev, ...ids])]);
    } catch {
      /* the roster refetch is a convenience — a failure here shouldn't break the log */
    }
  }

  // The person was just created from inside this modal — add them to the
  // picker's options and select them, ON TOP of whoever's already ticked
  // (creating someone mid-log usually means "…and I also met this new person").
  function handlePersonCreated(person) {
    setPeople((ps) => [...ps, person]);
    setSelectedPersonIds((ids) => [...new Set([...ids, person.id])]);
    setMetTypes((types) => [...new Set([...types.filter((t) => t !== 'nobody'), 'named_person'])]);
  }

  // Saves the form and marks the visit completed — this modal is just for
  // logging what happened, so saving it means it happened. Editing an existing
  // trip (or completing a planned stop) PATCHes it; otherwise POST a new
  // ad-hoc visit.
  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        ...form,
        status: 'completed',
        next_visit_date: form.next_visit_date || null,
        // '' -> null rather than 0: "not recorded" and "took no time" are
        // different answers, and the column is nullable for exactly that reason.
        actual_duration_minutes:
          form.actual_duration_minutes === '' ? null : Math.max(0, Math.round(Number(form.actual_duration_minutes))),
        // The trip's people, in full. The server UPSERTS BY ID: an entry
        // carrying the id of an encounter already on this trip updates in
        // place, an entry without one is inserted, and any encounter on file
        // whose id is absent from this array is deleted. So the ids have to
        // survive the round trip — sending them all id-less would delete and
        // recreate every encounter on every save, invalidating the ids
        // VisitDetailModal is holding for its per-encounter delete.
        encounters: encounters.map((e) => ({
          ...(e.id ? { id: e.id } : {}),
          met_with_type: e.met_with_type,
          person_id: e.person_id,
          outcome: detailFor(e.key).outcome,
          // Nobody can't have asked you for anything.
          they_requested: e.met_with_type === 'nobody' ? false : Boolean(detailFor(e.key).they_requested),
        })),
      };
      // Rounded client-side before it ever leaves the browser — the server
      // silently drops a non-integer capacity_monthly_referrals (it's a real
      // DB integer column) rather than erroring, so an un-rounded "12.5"
      // would otherwise look saved but quietly never land.
      if (needsPreQual && avgReferrals !== '') payload.capacity_monthly_referrals = Math.max(0, Math.round(Number(avgReferrals)));
      if (collisionWarning) payload.force = true; // "Save anyway" — re-submit past the warning already shown
      let saved;
      if (isEditing) {
        saved = await api.updateVisit(visit.visit_id, payload);
      } else {
        // A brand-new ad-hoc visit is attributed to whoever's logged in right
        // now — a scheduled stop already carries its own user_id from when
        // the route was generated, so this only applies to fresh visits.
        saved = await api.createVisit({
          place_id: placeId,
          user_id: userId,
          ...payload,
        });
      }
      onSaved?.(saved);
      setDone(true);
      // Show the "Visit logged. Well done." confirmation briefly before
      // auto-closing, instead of the modal just vanishing instantly.
      setTimeout(() => onClose(), 900);
    } catch (e) {
      if (e.code === 'VISIT_COLLISION') {
        setCollisionWarning(e.message);
        setSaving(false);
        return;
      }
      setError(e.message);
      setSaving(false);
    }
  }

  // After a successful save, swap the whole modal for a brief confirmation
  // message (see the setTimeout above that closes it).
  if (done) {
    return (
      <div className="modal-backdrop">
        <div className="modal" style={{ maxWidth: 360 }}>
          <div className="save-confirmation">
            <div className="check">✓</div>
            <div className="msg">Visit logged. Well done.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Log Visit — {title}</h2>
          <button className="close" title="Close without saving" onClick={onClose}>×</button>
        </div>
        {/* Nothing is editable until the trip's own encounters are in hand:
            a half-hydrated form saved early would drop the very ids this
            fetch exists to fetch. */}
        {loadingTrip ? (
          <div className="modal-body">
            {error && <div className="error-banner">{error}</div>}
            <div className="loading">Loading…</div>
          </div>
        ) : (
          <div className="modal-body">
            {error && <div className="error-banner">{error}</div>}
            {collisionWarning && <div className="error-banner">{collisionWarning}</div>}

            {status !== 'planned' && (
              <div>
                <label className="field">Date</label>
                <input
                  type="date"
                  value={form.scheduled_date}
                  max={today()}
                  onChange={(e) => { setCollisionWarning(null); set('scheduled_date')(e); }}
                />
              </div>
            )}

            {/* A trip can contain several encounters — a named contact AND the
                front desk, say. Each is scored on its own, so each person
                builds their own relationship score and the front-desk
                interaction scores against the place, while fatigue still
                counts the trip once. */}
            <div>
              <label className="field">Who did you meet?</label>
              <div className="person-checklist">
                {Object.entries(MET_WITH_LABELS).map(([key, label]) => (
                  <div
                    key={key}
                    className={`select-row${metTypes.includes(key) ? ' selected' : ''}`}
                    role="checkbox"
                    aria-checked={metTypes.includes(key)}
                    tabIndex={0}
                    onClick={() => toggleMetType(key)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMetType(key); } }}
                  >
                    {label}
                  </div>
                ))}
              </div>
              {lostPeople.length > 0 && (
                <div
                  className="tiny muted"
                  style={{ marginTop: 6 }}
                  title="This person's record was deleted — reassigning would rewrite this visit's history, so they can't be changed here. Remove them from the visit's own detail if they're wrong."
                >
                  Also on this visit: {lostPeople.map((e) => e.person_name || 'someone').join(', ')} (no longer on file)
                </div>
              )}
            </div>

            {metTypes.includes('named_person') && (
              <div>
                <label className="field">
                  Which people?
                  {selectedPersonIds.length > 1 && (
                    <span className="muted" style={{ fontWeight: 400 }}> · {selectedPersonIds.length} selected</span>
                  )}
                </label>
                {pickerPeople.length === 0 ? (
                  <div className="tiny muted">Nobody on file at this place yet — add someone below.</div>
                ) : (
                  <div className="person-checklist">
                    {pickerPeople.map((p) => (
                      <div
                        key={p.id}
                        className={`select-row${selectedPersonIds.includes(p.id) ? ' selected' : ''}`}
                        role="checkbox"
                        aria-checked={selectedPersonIds.includes(p.id)}
                        tabIndex={0}
                        onClick={() => togglePerson(p.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePerson(p.id); } }}
                      >
                        {p.name}{p.title ? <span className={selectedPersonIds.includes(p.id) ? '' : 'muted'}> — {p.title}</span> : null}
                      </div>
                    ))}
                  </div>
                )}
                <div className="tag-list" style={{ marginTop: 8 }}>
                  <Button variant="secondary" size="small" title="Create someone who isn't on file yet" onClick={() => setCreatingPerson(true)}>
                    + Create new person
                  </Button>
                  <Button variant="secondary" size="small" title="Link someone already on file to this place" onClick={() => setAssigningPerson(true)}>
                    + Assign someone on file
                  </Button>
                </div>
              </div>
            )}

            {/* One block per encounter, hidden entirely until there's at least
                one — an empty "What happened?" heading over nothing reads as a
                broken form rather than a question waiting on an answer. */}
            {encounters.length > 0 && (
              <div>
                <label className="field">What happened?</label>
                <div className="stack encounter-list" style={{ gap: 10 }}>
                  {encounters.map((e) => (
                    <div key={e.key} className="encounter-row">
                      <div className="encounter-name">{e.label}</div>
                      <select
                        value={detailFor(e.key).outcome}
                        onChange={(ev) => setDetail(e.key, { outcome: ev.target.value })}
                      >
                        <option value="">Select what happened…</option>
                        {Object.entries(OUTCOME_LABELS).map(([key, label]) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
                      {/* Them asking US for something is the purest reciprocity
                          signal available — it measures their investment, not
                          the rep's. Asked per encounter because it's a fact
                          about one person, not the whole visit. Nobody can't
                          have asked you for anything. */}
                      {e.met_with_type !== 'nobody' && (
                        <div
                          className={`select-row${detailFor(e.key).they_requested ? ' selected' : ''}`}
                          title="Materials, availability, a callback — anything they asked you for"
                          role="checkbox"
                          aria-checked={Boolean(detailFor(e.key).they_requested)}
                          tabIndex={0}
                          onClick={() => setDetail(e.key, { they_requested: !detailFor(e.key).they_requested })}
                          onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setDetail(e.key, { they_requested: !detailFor(e.key).they_requested }); } }}
                        >
                          <span className="check-box-visual" aria-hidden="true" />
                          They asked me for something
                        </div>
                      )}
                      {/* A nudge, not an action — meeting someone new is easy
                          to forget to actually add once the rep moves on. */}
                      {detailFor(e.key).outcome === 'introduced_new' && (
                        <div className="tiny muted">Have you added them to this place yet?</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label className="field">Notes</label>
              <textarea rows={3} value={form.notes} onChange={set('notes')} placeholder="What happened, next steps…" autoFocus />
            </div>

            <div className="row">
              <div>
                <label className="field">How long did it take? (minutes)</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Optional"
                  value={form.actual_duration_minutes}
                  onChange={set('actual_duration_minutes')}
                />
              </div>
              {needsPreQual && (
                <div>
                  <label className="field">Avg. referrals/month discovered at pre-qual</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="Optional"
                    value={avgReferrals}
                    onChange={(e) => setAvgReferrals(e.target.value)}
                  />
                </div>
              )}
            </div>
          </div>
        )}
        <div className="modal-foot">
          <Button variant="secondary" title="Close without saving" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant={collisionWarning ? 'danger' : 'primary'}
            title={
              collisionWarning
                ? 'Log this visit anyway, despite the collision above'
                : canSave
                  ? 'Save this visit'
                  : 'Fill in who you met, what happened, and a note first'
            }
            onClick={save}
            disabled={saving || !canSave}
          >
            {saving ? 'Saving…' : collisionWarning ? 'Save anyway' : 'Save'}
          </Button>
        </div>
      </div>

      {creatingPerson && (
        <PersonModal
          placeId={resolvedPlaceId}
          placeName={title}
          onClose={() => setCreatingPerson(false)}
          onSaved={handlePersonCreated}
        />
      )}

      {assigningPerson && (
        <AssignPersonModal
          placeId={resolvedPlaceId}
          placeName={title}
          onClose={() => setAssigningPerson(false)}
          onAssigned={handlePeopleAssigned}
        />
      )}
    </div>
  );
}
