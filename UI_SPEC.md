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
