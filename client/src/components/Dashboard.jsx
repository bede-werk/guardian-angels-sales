import React, { useEffect, useState, useCallback } from 'react';
import { api, formatDate, suppressionNote, navigateRouteUrl, VISIT_TYPE_LABELS } from '../api';
import EmptyState from './ui/EmptyState';
import Button from './ui/Button';
import PlaceDetail from './PlaceDetail';
import PersonDetail from './PersonDetail';
import UpcomingVisitDetailModal from './UpcomingVisitDetailModal';
import VisitLogModal from './VisitLogModal';
import PlannedDayModal from './PlannedDayModal';
import { getCurrentPosition } from '../geolocation';

// The five things the dashboard answers, in the order it answers them
// (2026-08-18, replacing the old two-card "completed this week + never
// visited" screen):
//
//   1. Today                - what the next few hours look like
//   2. This week            - whether the week is on track
//   3. Commitments due      - promises that are about to come due, or already have
//   4. Recent referrals     - what the work is actually producing
//   5. Top referral partners- who is producing it
//
// One request drives all five: GET /api/dashboard (server/src/routes/
// dashboard.js), which is also where the scoping rules live - 1 and 2 are
// this rep's own day and week, 3, 4 and 5 are org-wide.
//
// Like every other tab, this is a normal, fully-interactive page - nothing
// about being "the dashboard" makes it read-only. The Today card's "View
// all stops" link already opens the same full-featured PlannedDayModal
// VisitsCalendar's own day drill-down uses (log/snooze/edit/delete a visit,
// whole-day Edit/Discard), and there's no reason a future card here
// couldn't do the same. Most rows today just link out to the screen that
// owns the thing they name (PlaceDetail, PersonDetail, the Calendar tab)
// because building each one inline hasn't been worth it yet, not because
// of some rule against it.

// Mon..Sun initials for the week strip. Single letters, because the strip is
// seven columns inside one card and even "Mon" wraps at narrow widths.
const DOW_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

// A commitment's due-ness as a short phrase, plus which chip class carries
// it. days_out is signed and comes from the server (negative = overdue) so
// this never re-derives "is it late" from a date compare that could disagree
// with the server's notion of today.
function dueLabel(daysOut) {
  if (daysOut < 0) return { text: daysOut === -1 ? 'Overdue by 1 day' : `Overdue by ${-daysOut} days`, tone: 'overdue' };
  if (daysOut === 0) return { text: 'Due today', tone: 'today' };
  if (daysOut === 1) return { text: 'Tomorrow', tone: 'soon' };
  if (daysOut <= 7) return { text: `In ${daysOut} days`, tone: 'soon' };
  return { text: `In ${daysOut} days`, tone: 'later' };
}

// How many missing-address places the caveat names before it stops listing
// them. The line is one nowrap row in a fixed amount of reserved space (see
// .dash-nav-caveat), and place names here run long ("Homewood at Frederick
// Rehabilitation Center"), so two is where naming them stops being the
// short version and starts being the list. Past that it says how many.
const MAX_NAMED_NO_ADDRESS = 2;

// The caveat under the Navigate button. Two unrelated things can keep a stop
// out of that link, and the line has to name the right one: Google Maps' cap
// on a single link (nothing anyone can do about it) versus a stop with no
// address on file. They used to share one count, so a 3-stop day with one
// address missing claimed the day was too long for Maps.
//
// The missing-address half NAMES the places and links them straight to
// PlaceDetail, because it is the only half a rep can act on and the address
// field is one modal away. Not every such stop is openable: place deletion
// is ON DELETE SET NULL (detach-not-delete), so a planned stop can outlive
// its place - keeping visits.place_name as a snapshot but having no place
// left to open. That is the same split the commitments card below makes
// with its own `openable`, and it renders the same way (plain text, no
// link). A detached stop is in fact the likeliest one to land here at all,
// since every real place currently on file does have an address.
//
// Renders ONE line: .dash-nav-caveat is absolutely positioned into a single
// line's worth of reserved space (styles.css - that reservation is what
// keeps the Navigate button from shifting on days that have a caveat), so
// the rare day that trips both joins them rather than stacking.
function NavCaveat({ nav, onOpenPlace }) {
  const capped = nav.overCap > 0;
  const missing = nav.noAddressStops;
  if (!capped && missing.length === 0) return null;

  const named = missing.slice(0, MAX_NAMED_NO_ADDRESS);
  const unnamed = missing.length - named.length;

  return (
    <div className="muted tiny dash-nav-caveat">
      {capped && <>Only the first {nav.included} of {nav.included + nav.overCap} stops fit in one Maps trip</>}
      {capped && missing.length > 0 && ' · '}
      {missing.length > 0 && (
        <>
          {named.map((stop, i) => (
            <React.Fragment key={stop.visit_id}>
              {i > 0 && ', '}
              {stop.place_id != null ? (
                <button type="button" className="link-button" onClick={() => onOpenPlace(stop.place_id)}>
                  {stop.name}
                </button>
              ) : (
                stop.name || 'A removed place'
              )}
            </React.Fragment>
          ))}
          {unnamed > 0 && ` and ${unnamed} more`}
          {' '}left out. No address on file
        </>
      )}
    </div>
  );
}

// The Today card's "Next visit" - a small card, not a link, since this is
// the single most load-bearing fact on the whole dashboard and it deserves
// more visual weight than a line of underlined text. Shows the visit TYPE
// (what kind of stop this is) rather than the city - the city is already
// implied ("today's route"), where the visit type tells you something you
// don't already know just from the place's name. Clicking it opens the
// VISIT (UpcomingVisitDetailModal), not the place - every stop here always
// has a real visit_id behind it (unlike place_id, which a detach can null
// out), so unlike the old place-opening version this never needs a
// non-interactive fallback card.
function StopLine({ label, stop, onOpenVisit, loading }) {
  if (!stop) return null;
  // A manually-created ad hoc visit can carry no visit_type at all (blank,
  // not just untyped) - falling back to "no type" text rather than
  // dropping the line entirely, so the card is never silently missing its
  // second line.
  const visitType = VISIT_TYPE_LABELS[stop.visit_type] || 'No visit type set';
  return (
    <div className="dash-next-visit">
      <div className="dash-fact-label">{label}</div>
      <button type="button" className="dash-stop-card" disabled={loading} onClick={() => onOpenVisit(stop.visit_id)}>
        <div className="dash-stop-name">{stop.name}</div>
        <div className="muted tiny">{visitType}</div>
      </button>
    </div>
  );
}

export default function Dashboard({ date, userId, onNavigateToPlanner }) {
  const [data, setData] = useState(null); // the dashboard API response, or null while loading
  const [error, setError] = useState(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState(null); // which place's detail modal is open, if any
  const [selectedPersonId, setSelectedPersonId] = useState(null); // which person's detail modal is open, if any
  const [viewingVisit, setViewingVisit] = useState(null); // the fetched visit open in UpcomingVisitDetailModal, or null
  const [loggingVisit, setLoggingVisit] = useState(null); // viewingVisit handed off to VisitLogModal for completing, or null
  const [viewingTodayRoute, setViewingTodayRoute] = useState(false); // true while today's full stop list is open in PlannedDayModal
  const [visitLoading, setVisitLoading] = useState(false); // true while openVisit's fetch is in flight - blocks a second click firing a second fetch
  const [visitLoadError, setVisitLoadError] = useState(null);
  const [reopeningToday, setReopeningToday] = useState(false); // true while today's visits are being pulled back into an editable Route Planner draft
  const [deletingToday, setDeletingToday] = useState(false); // true while today's planned visits are being discarded
  const [todayActionError, setTodayActionError] = useState(null); // inline banner for the Edit/Discard actions below - same shape as VisitsCalendar's actionError

  // The Today card's "Next visit" only has a narrow stop shape (see
  // routes/dashboard.js's select) - not the full visit UpcomingVisitDetailModal
  // needs (notes, user_name, crossRepFloorWarning, encounters). Every OTHER
  // place that opens this modal already has the full row in hand from its
  // own broader fetch (PlaceDetail's upcoming_visits, PlannedDayModal's day
  // list); this is the one spot with only an id, so it fetches the one
  // visit it needs via the same GET /api/visits/:id every full visit view
  // in the app is built on, rather than duplicating that shape into the
  // dashboard rollup for a single row.
  async function openVisit(visitId) {
    setVisitLoadError(null);
    setVisitLoading(true);
    try {
      setViewingVisit(await api.visit(visitId));
    } catch (e) {
      setVisitLoadError(e.message);
    } finally {
      setVisitLoading(false);
    }
  }

  // Same confirm+delete+reload shape as PlannedDayModal's own removeVisit -
  // deletes ONE planned visit, called from the Delete button UpcomingVisitDetailModal
  // renders when onDelete is passed.
  async function removeViewingVisit(visit) {
    if (!window.confirm("Delete this planned visit? This can't be undone.")) return;
    try {
      await api.deleteVisit(visit.visit_id ?? visit.id);
      setViewingVisit(null);
      load();
    } catch (e) {
      window.alert(e.message);
    }
  }

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.dashboard(userId, date));
    } catch (e) {
      setError(e.message);
    }
  }, [date, userId]);

  // Reload whenever the logged-in user or date changes (date never actually
  // changes today since there's no date picker, but userId can).
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="loading">Loading dashboard…</div>;

  const { today, this_week: week, commitments_due: due, recent_referrals: referrals, top_referral_partners: partners } = data;
  // Not-yet-completed stops, in route order. This is what the count tile
  // and the Navigate link actually track (both 2026-08-18): a stop that's
  // already been logged has nothing left to count or drive to.
  const remainingStops = today.route.filter((s) => s.status === 'planned');
  // Whichever stop is actually next: today.next_stop once the day is
  // underway (the server already nulls it out when it's the same as
  // first_stop, to avoid naming one place twice), falling back to
  // first_stop before anything's been logged. Once every planned stop is
  // done there IS no next one - counts.planned === 0 catches that, so this
  // doesn't fall back to first_stop and misname an already-completed stop
  // as still ahead.
  const upNext = today.counts.planned > 0 ? (today.next_stop || today.first_stop) : null;
  // null when nothing REMAINING has a usable address at all, or nothing is
  // left to drive to (every stop done, or none scheduled) - the button
  // just doesn't render rather than linking to a broken or empty Maps URL.
  const routeNav = navigateRouteUrl(remainingStops);

  // Pulls today's visits back out into an editable Route Planner draft -
  // same endpoint/confirm copy/geolocation dance as VisitsCalendar's own
  // reopenPlannedDay. This screen has no draft workspace of its own to show
  // the result in either, so a successful reopen hands off to the Route
  // Planner tab (onNavigateToPlanner) instead of rendering anything here.
  async function reopenTodayRoute() {
    if (!window.confirm("Edit today's planned visits? They'll temporarily show as not-yet-scheduled while you make changes - accept the updated proposal again when you're done.")) return false;
    setTodayActionError(null);
    setReopeningToday(true);
    try {
      const loc = await getCurrentPosition();
      await api.scheduleDrafts.reopenDay(today.date, { lat: loc.lat, lng: loc.lng });
      return true;
    } catch (e) {
      setTodayActionError(e.message);
      return false;
    } finally {
      setReopeningToday(false);
    }
  }

  // Same endpoint/confirm copy as VisitsCalendar's deletePlannedDay. Reloads
  // the dashboard on success (unlike the reopen path above, which navigates
  // away instead) so the count tile and Next visit card drop the discarded
  // stops immediately.
  async function deleteTodayRoute() {
    if (!window.confirm("Remove today's planned visits? This can't be undone.")) return false;
    setTodayActionError(null);
    setDeletingToday(true);
    try {
      await api.scheduleDrafts.deleteCommittedDay(today.date);
      await load();
      return true;
    } catch (e) {
      setTodayActionError(e.message);
      return false;
    } finally {
      setDeletingToday(false);
    }
  }

  return (
    <div className="grid">

      {/* ------------------------------------------------------ 1. Today */}
      {/* The reason this screen exists: the day's route at a glance, with
          one click out to actual turn-by-turn directions. */}
      <div className="card dash-today">
        <div className="card-head">
          <h2>Today</h2>
          <span className="muted tiny">{formatDate(today.date)}</span>
        </div>
        <div className="card-body dash-today-body">
          <div className="dash-today-facts">
            {/* Count + View button pieced together as one section - a stat
                and the action that belongs to it - separated only by a
                short hairline, much smaller than the full-height divider
                before Next visit (a separate fact). */}
            <div className="dash-today-summary">
              {/* A running tally of what's LEFT, not the day's total (Bede,
                  2026-08-18) - it counts down as each stop gets logged,
                  rather than sitting fixed at the morning's count all day. */}
              <div className="dash-today-count">
                <div className="num">{remainingStops.length}</div>
                <div className="label">{remainingStops.length === 1 ? 'stop' : 'stops'} left today</div>
              </div>
              {remainingStops.length > 0 && (
                <>
                  <span className="dash-summary-divider" aria-hidden="true" />
                  <Button variant="secondary" size="small" className="dash-view-all-link" onClick={() => setViewingTodayRoute(true)}>
                    {/* "View all 1 stop" reads wrong - "all" implies more than
                        one - so the singular case drops both "all" and the
                        redundant count instead of just fixing the noun's
                        plural. */}
                    {remainingStops.length === 1 ? 'View the stop planned today' : `View all ${remainingStops.length} stops planned today`}
                  </Button>
                </>
              )}
            </div>
            {/* Side by side, not stacked above Next visit - same reasoning
                as dash-next-visit's own row-not-stacked layout below: a
                stack would pull the block's center up with the summary's own
                height, taking Next visit's card off the Today card's true
                vertical center with it. As a separate flex item instead,
                Next visit centers on its own height and the summary centers
                against it, landing lower than a plain top-aligned stack
                would put it. */}
            <div className="dash-today-next">
              {/* One message for both "nothing was ever scheduled" and "it's
                  all done" - from here, they're the same fact (nothing left
                  to do today), and neither has an actual next visit to
                  caption, so the "Next visit" label doesn't show for either. */}
              {upNext ? (
                <StopLine label="Next visit" stop={upNext} onOpenVisit={openVisit} loading={visitLoading} />
              ) : (
                <div className="muted">Nothing left for today</div>
              )}
              {visitLoadError && <div className="muted tiny dash-visit-error">Couldn&rsquo;t open that visit: {visitLoadError}</div>}
            </div>
          </div>

          <div className="dash-today-action">
            {routeNav && (
              <a
                className="btn"
                href={routeNav.url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open every stop still ahead today as one set of driving directions in Google Maps"
              >
                Navigate today&rsquo;s route ↗
              </a>
            )}
            {/* Why a stop isn't in the link - see NavCaveat above. Neither
                reason is the common case, so most days this renders
                nothing at all. */}
            {routeNav && <NavCaveat nav={routeNav} onOpenPlace={setSelectedPlaceId} />}
          </div>
        </div>
        {/* Edit/Discard failures from the full-day modal below - same inline
            placement/wording pattern as VisitsCalendar's own actionError. */}
        {todayActionError && <div className="error-banner dash-today-action-error">{todayActionError}</div>}
      </div>

      <div className="dash-row">

        {/* ------------------------------------------------ 2. This week */}
        <div className="card">
          <div className="card-head">
            <h2>This week</h2>
            <span className="muted tiny">{formatDate(week.start)} → {formatDate(week.end)}</span>
          </div>
          <div className="card-body">
            <div className="dash-week-numbers">
              <div><strong>{week.completed}</strong> <span className="muted tiny">completed</span></div>
              <div><strong>{week.planned}</strong> <span className="muted tiny">still planned</span></div>
              {week.skipped > 0 && <div><strong>{week.skipped}</strong> <span className="muted tiny">skipped</span></div>}
              <div><strong>{week.places_visited}</strong> <span className="muted tiny">places reached</span></div>
            </div>

            {/* Seven fixed columns, Monday to Sunday, empty days included -
                the shape of the week is the point, so a quiet Thursday has
                to be visible as a gap rather than closed up. */}
            <div className="week-strip">
              {week.days.map((day, i) => (
                <div key={day.date} className={`week-day ${day.date === data.date ? 'is-today' : ''}`}>
                  <div className="week-day-dow">{DOW_INITIALS[i]}</div>
                  <div className="week-day-counts" title={`${formatDate(day.date)}: ${day.completed} completed, ${day.planned} planned${day.skipped ? `, ${day.skipped} skipped` : ''}`}>
                    {day.completed > 0 && <span className="week-pip done">{day.completed}</span>}
                    {day.planned > 0 && <span className="week-pip planned">{day.planned}</span>}
                    {day.skipped > 0 && <span className="week-pip skipped">{day.skipped}</span>}
                    {day.completed + day.planned + day.skipped === 0 && <span className="week-pip empty">·</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ----------------------------------------- 3. Commitments due */}
        {/* Place-level and cross-rep on purpose (see the route's header): a
            promise the company made shows up here whoever made it. */}
        <div className="card">
          <div className="card-head">
            <h2>Commitments due</h2>
            <span className="muted tiny">
              next {due.horizon_days} days
              {due.overdue_count > 0 && <> · <span className="dash-overdue-count">{due.overdue_count} overdue</span></>}
            </span>
          </div>
          <div className="card-body">
            {due.items.length === 0 ? (
              <EmptyState compact message="No promises coming due. Nothing owed, nothing late." />
            ) : (
              <ul className="list">
                {due.items.map((c) => {
                  const label = dueLabel(c.days_out);
                  // A commitment outlives its place (detach-not-delete), and
                  // a detached one has no place to open - and no name either,
                  // since place_commitments keeps no name snapshot the way
                  // visits.place_name does.
                  const openable = c.place_id != null;
                  return (
                    <li key={c.id} className={`stop ${openable ? 'hover-row' : ''}`} onClick={openable ? () => setSelectedPlaceId(c.place_id) : undefined}>
                      <div className="main">
                        <div className="name tiny">{c.place_name || 'Place removed'}</div>
                        <div className="meta">
                          {[
                            formatDate(c.promised_date),
                            c.person_name && `promised to ${c.person_name}`,
                            c.city,
                          ].filter(Boolean).join(' · ')}
                          {/* The one genuine contradiction worth surfacing
                              here: a promise to return, sitting on a place
                              the planner is currently forbidden to propose.
                              Same shared rule every other screen uses. */}
                          {suppressionNote(c)}
                        </div>
                        {c.note && <div className="meta">“{c.note}”</div>}
                      </div>
                      <div className="actions">
                        <span className={`due-chip ${label.tone}`}>{label.text}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {due.count > due.items.length && (
              <div className="muted tiny" style={{ paddingTop: 10 }}>
                {due.count - due.items.length} more due in this window - see each place for the full list.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="dash-row">

        {/* ------------------------------------------ 4. Recent referrals */}
        <div className="card">
          <div className="card-head">
            <h2>Recent referrals</h2>
            <span className="muted tiny">{referrals.window_count} in the last {referrals.window_days} days</span>
          </div>
          <div className="card-body">
            {referrals.items.length === 0 ? (
              <EmptyState compact message="No referrals logged yet." />
            ) : (
              <ul className="list">
                {referrals.items.map((r) => (
                  <li
                    key={r.id}
                    className={`stop ${r.person_id ? 'hover-row' : ''}`}
                    onClick={r.person_id ? () => setSelectedPersonId(r.person_id) : undefined}
                  >
                    <div className="main">
                      <div className="name tiny">{r.person_name || 'Contact removed'}</div>
                      <div className="meta">
                        {[r.person_title, r.place_name, r.city].filter(Boolean).join(' · ') || 'No place on file'}
                      </div>
                    </div>
                    <div className="actions">
                      <span className="muted tiny">{r.referral_date ? formatDate(r.referral_date) : 'no date'}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* -------------------------------------- 5. Top referral partners */}
        <div className="card">
          <div className="card-head">
            <h2>Top referral partners</h2>
            <span className="muted tiny">by referrals sent, all time</span>
          </div>
          <div className="card-body">
            {partners.items.length === 0 ? (
              <EmptyState compact message="Nobody has sent a referral yet." />
            ) : (
              <ul className="list">
                {partners.items.map((p, i) => (
                  <li key={p.person_id} className="stop hover-row" onClick={() => setSelectedPersonId(p.person_id)}>
                    <div className="order">{i + 1}</div>
                    <div className="main">
                      <div className="name tiny">{p.person_name}</div>
                      <div className="meta">
                        {[p.person_title, p.place_name || 'No place on file', p.city].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <div className="actions partner-score">
                      <span className="partner-count">{p.lifetime_referrals}</span>
                      {/* The lifetime number alone can't tell a live partner
                          from one who stopped years ago - the recent figure
                          next to it is what separates them. */}
                      <span className="muted tiny">{p.recent_referrals} in {partners.window_days}d</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* Clicking any place row/name above opens this same detail modal. */}
      {selectedPlaceId && (
        <PlaceDetail placeId={selectedPlaceId} userId={userId} onClose={() => setSelectedPlaceId(null)} onChanged={load} onDeleted={load} />
      )}
      {selectedPersonId && (
        <PersonDetail
          personId={selectedPersonId}
          userId={userId}
          onClose={() => setSelectedPersonId(null)}
          onChanged={load}
          onDeleted={load}
          onOpenPlace={(placeId) => setSelectedPlaceId(placeId)}
        />
      )}
      {/* Same log/snooze/edit/delete wiring as PlannedDayModal's own
          viewingVisit below - load() stands in for its reloadOwnVisits+
          onChanged pair, since this card's count/Next-visit both come from
          the one dashboard fetch rather than a separate visits list. */}
      {viewingVisit && (
        <UpcomingVisitDetailModal
          visit={viewingVisit}
          userId={userId}
          onClose={() => setViewingVisit(null)}
          onComplete={(v) => { setViewingVisit(null); setLoggingVisit(v); }}
          onSnoozed={() => { setViewingVisit(null); load(); }}
          onDelete={removeViewingVisit}
          onEdited={() => { setViewingVisit(null); load(); }}
        />
      )}
      {loggingVisit && (
        <VisitLogModal
          visit={loggingVisit}
          userId={userId}
          onClose={() => setLoggingVisit(null)}
          onSaved={load}
        />
      )}
      {/* Logging/snoozing/editing/deleting a visit, or editing/discarding
          the whole day, all work exactly as they do from VisitsCalendar's
          own drill-down - this is this rep's own day, so there's no reason
          any of it should be locked down here. onChanged reloads the
          dashboard so the count tile and Next visit card reflect whatever
          changed; onEditDay pulls the day into a Route Planner draft and
          hands off there instead (see reopenTodayRoute above), same as
          VisitsCalendar's own Edit. */}
      {viewingTodayRoute && (
        <PlannedDayModal
          date={today.date}
          userId={userId}
          onChanged={load}
          onClose={() => setViewingTodayRoute(false)}
          onViewPlace={(placeId) => setSelectedPlaceId(placeId)}
          onEditDay={async () => {
            const reopened = await reopenTodayRoute();
            if (reopened) {
              setViewingTodayRoute(false);
              onNavigateToPlanner?.();
            }
          }}
          editingDay={reopeningToday}
          onDeleteDay={async () => { if (await deleteTodayRoute()) setViewingTodayRoute(false); }}
          deletingDay={deletingToday}
        />
      )}
    </div>
  );
}
