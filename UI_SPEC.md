# UI Spec

Status: living document, started 2026-08-17. Not a redesign plan - a catalog of
patterns that already exist in the app, written down as they get audited and
unified so the next new screen reuses what's here instead of inventing a
fourth kind of button.

## How this doc works

We go element-by-element, on request. Each section below covers one kind of
UI affordance (a button family, a chip, a card layout, ...):

- **What it's for** - the job this pattern does, in plain terms.
- **Kinds** - the canonical variants, each with its CSS class/component, exact
  visual spec, and current usage locations.
- **Decision rule** - given a new spot that needs this kind of affordance,
  which variant to reach for.

When a new element gets audited, add a new `##` section the same way rather
than editing this intro. If a decision rule turns out to be wrong in
practice, fix the rule here, don't leave the doc silently stale - see
`HANDOFF.md`'s staleness problem for why that matters.

---

## Dismiss / remove / delete ("x" buttons)

Audited and unified 2026-08-17 (see `client/src/styles.css`'s `.close` /
`.icon-remove` rules and `client/src/components/ui/Button.jsx`). Before this
pass there were 6 different x's in the app (three separate near-identical
inline-delete classes plus the two below); now there are 4.

### Kind 1 - Modal close

- **Class:** `.close`
- **Glyph:** `×`
- **Look:** 22px, muted grey, no background/border, no hover state, no
  padding (relies on the button's own box).
- **Job:** closes/cancels a whole modal. Never destroys data by itself - it's
  the same action as clicking the backdrop or hitting Escape.
- **Where:** top-right corner of every `*Modal.jsx` / `*Detail.jsx` panel -
  about 22 instances, one per modal.

### Kind 2 - Inline row remove

- **Class:** `.icon-remove`
- **Glyph:** `✕`
- **Look:** 9px, mauve at rest, mauve-tint background on hover, no
  border/background at rest, `padding: 6px 8px` (clickable area sized to the
  glyph, not stretched out).
- **Job:** delete a single row out of an inline list/history without leaving
  the panel - low-ceremony, but still a real (often permanent) delete.
- **Where:** `CapacityDetail.jsx` (delete a capacity observation),
  `PlaceCommitments.jsx` (delete a discharged commitment from history),
  `VisitDetailModal.jsx` (remove a person from a visit's encounter list).
  3 instances. These three used to be three separate classes
  (`.icon-remove`/`.icon-delete`/`.icon-remove-danger`) with different sizes,
  borders, and padding - merged into one.

### Kind 3 - Danger pill button

- **Component:** `<Button variant="danger" size="small">✕</Button>`
- **Glyph:** `✕`
- **Look:** mauve-tint-1 background pill, mauve text, 12px, `padding: 4px
  8px` (via `.btn.small`).
- **Job:** delete something with more weight than kind 2 - destroying a whole
  record (a referral, a visit, a category), not just trimming a history row.
- **Where:** `CategoriesModal.jsx` (delete category), `PersonDetail.jsx` ×2
  (delete referral, delete visit), `PlaceDetail.jsx` (delete visit),
  `RoutePlanner.jsx` (remove a stop from a day). 5 instances.

### Kind 4 - Ghost pill button

- **Component:** `<Button variant="ghost" size="small">✕</Button>`
- **Glyph:** `✕`
- **Look:** same shape/padding as kind 3, but no fill at rest, blue text,
  blue-tint on hover.
- **Job:** a *non-destructive* detach - unassigning or unlinking something
  that still exists elsewhere afterward, not deleting it.
- **Where:** `PersonDetail.jsx` (unassign person from a place),
  `PlaceDetail.jsx` (unassign person from a place), `RoutePlanner.jsx`
  (remove a not-yet-proposed date from the date picker). 3 instances.

### Decision rule

1. Is this closing/cancelling an entire modal? -> **Kind 1** (`.close`).
2. Is this reversible - the thing still exists elsewhere, you're just
   unlinking it here? -> **Kind 4** (ghost pill).
3. Is this a real delete, sitting inline in a dense list/history rather than
   as a standalone row action? -> **Kind 2** (`.icon-remove`).
4. Is this a real delete of a whole record, weighty enough to want a more
   visible button? -> **Kind 3** (danger pill).

The line between 2 and 3 is a judgment call (both are genuine deletes) - the
tiebreaker is ceremony: history-list cleanup reads as routine (kind 2),
destroying a whole visit/referral/category reads as consequential (kind 3).
When in doubt, ask rather than guess - that line moved once already in this
audit and is worth getting right per-case rather than by rote.

---

## Status/level chips (colored pill labels)

Audited 2026-08-22 when the Visits tab needed a fourth family. All four live in
`client/src/components/ui/Chip.jsx` and share one visual language: a `.badge`
base class plus a `-{value}` suffix picking the color, always three tints per
family (best/neutral/worst, or a direct semantic mapping for statuses).

### The four families

- **`OutcomeChip`** (`.badge.o-*`) - a visit's outcome (substantive /
  introduced_new / brief / materials_only / unavailable / declined).
- **`RelationshipChip`** (`.badge.rel-*`) - computed relationship level
  (strong/medium/weak -> teal/blue/grey).
- **`CapacityChip`** (`.badge.cap-*`) - computed capacity level (high/medium/low
  -> the same teal/blue/grey scale as relationship, a different axis but the
  same "which tier is this" visual language).
- **`StatusChip`** (`.badge.st-*`), new - a visit's status (planned/completed/
  skipped/snoozed). Completed reuses the "good" teal; planned reuses the
  neutral blue; skipped is grey (a passive lapse, not a verdict - see
  `services/visitLifecycle.js`'s sweep); snoozed uses the mauve warning tint
  since it's a deliberate deferral worth noticing, not routine history. Used
  today only in the Visits tab's table - every other visit surface already
  groups by status into separate lists/cards instead of needing an inline
  label for it.

### Decision rule

A new computed level/state gets its own `-prefix` family (not folded into an
existing one) when its value set means something different from every
existing family's - reusing `rel-`'s three colors for a fourth thing would
make two unrelated pills look identical by accident. Keep the "how many
distinct values" question separate from "which colors": three-tint families
reuse the teal/blue/grey scale by convention; a family with a different
number of values (StatusChip has four) just extends the same underlying
`--*-tint-*` custom properties rather than inventing new ones.

---

## Titles (card heads, modal heads, section heads)

Audited 2026-08-25. Every visible heading in the app - `.card-head h2`,
`.modal-head h2`, `.settings-section-head h3`, `.day-overview-popover-head h3`
- follows the same three rules. The model to copy is `VisitLogModal.jsx`:
`Log Visit · Sunrise Manor`.

### Rule 1 - Title Case

Capitalize every word except articles, coordinating conjunctions, and short
prepositions (`a`, `an`, `the`, `and`, `or`, `of`, `to`, `by`, `in`, `at`).
Both halves of a hyphenated compound get capitalized (`Per-Stop Overhead`).

`Commitments Due`, `Top Referral Partners`, `Starting Guess by Category`,
`Rolling People Up to Their Place`. Not `Commitments due`.

This covers the Settings catalogue too: `section.title` and `group.title` in
`server/src/config/tunables.js` are rendered as real headings, so they follow
the same rule. (Their sibling `label:` fields are *form field labels*, not
titles - those stay sentence case.)

### Rule 2 - What it is first, which one second

A heading that carries a date, a place name, a person's name, or a rep's name
leads with the noun for what the thing *is*, then the identifying part:

- `Planned Route · Mon, Aug 25` - not `Mon, Aug 25 · Planned Route`
- `Skipped Visits · Mon, Aug 25`, `Completed Visits · …`, `Birthdays · Aug 25`
- `Visit · Mon, Aug 25`, `Commitment · …`, `Referral · …`
- `Log Visit · Sunrise Manor`, `Plan a Visit · …`, `Add a Person · …`
- Multiple identifiers chain in the same order, widest first:
  `Planned Route · Nikki Shasserre · Mon, Aug 25`

A heading whose identifying part is the *entire* subject stays bare - the
person/place name at the top of `PersonDetail`/`PlaceDetail`, or a day
popover that is only ever "this day" (`DayOverflowModal`). There's no noun to
put in front of those without inventing copy.

### Rule 3 - Raised dots, never dashes

The separator between segments is ` · ` (U+00B7, spaces both sides). Not
` - `, not an en/em dash. Dashes inside a single word are fine (`Per-Stop`);
this rule is about separators.

### Decision rule

Writing a new heading: say what the thing is in Title Case, then append
` · ` plus each identifier from widest scope to narrowest. If the heading is
only a name or only a date, leave it bare rather than bolting on a noun.
Sentence-case prose that happens to sit near a heading (`.settings-section-blurb`,
`.meta`, `.tiny`, tooltips, `EmptyState` messages) is not a title and is not
covered by any of this.
