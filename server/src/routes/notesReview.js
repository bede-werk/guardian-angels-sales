// "Needs Mapping" — historical notes imported from ReferrerNotes.xlsx whose
// referrer text couldn't be automatically matched to a place (see
// scripts/import-notes.js). This screen lets a person manually resolve each
// one: assign it to an existing place, create a brand-new place from it,
// or dismiss it. Resolving a note converts it into a real completed visit.
const express = require('express');
const knex = require('../db/knex');

const router = express.Router();

// GET /api/notes-review?status=pending — the "needs mapping" bucket.
// Grouped by referrer so you can map all of a referrer's notes at once.
router.get('/', async (req, res, next) => {
  try {
    const status = req.query.status || 'pending';
    const rows = await knex('notes_review as n')
      .leftJoin('users as u', 'u.id', 'n.author_user_id')
      .where('n.status', status)
      .orderBy('n.referrer_raw', 'asc')
      .orderBy('n.note_date', 'desc')
      .select('n.*', 'u.name as author_name');

    // Group the flat row list by referrer name for the UI (one card per referrer).
    const groups = {};
    for (const r of rows) {
      if (!groups[r.referrer_raw]) groups[r.referrer_raw] = { referrer: r.referrer_raw, notes: [] };
      groups[r.referrer_raw].notes.push(r);
    }
    res.json({
      count: rows.length,
      referrer_count: Object.keys(groups).length,
      groups: Object.values(groups).sort((a, b) => b.notes.length - a.notes.length), // biggest backlog first
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/notes-review/count — pending count (for the tab badge in the header).
router.get('/count', async (req, res, next) => {
  try {
    const row = await knex('notes_review').where({ status: 'pending' }).count({ c: '*' }).first();
    res.json({ pending: Number(row.c) });
  } catch (err) {
    next(err);
  }
});

// Convert one review row into a completed visit on a place, and mark the
// review row as resolved. Shared by both the "assign" and "create-place" routes.
async function assignRowToPlace(trx, review, placeId) {
  const [row] = await trx('visits')
    .insert({
      place_id: placeId,
      user_id: review.author_user_id || null,
      scheduled_date: review.note_date,
      status: 'completed',
      source: 'imported_note', // distinguishes it from visits logged directly in the app
      notes: review.note_text,
      completed_at: review.note_date ? `${review.note_date} 12:00:00` : trx.fn.now(),
    })
    .returning('id');
  const visitId = row && row.id ? row.id : row;
  await trx('notes_review')
    .where({ id: review.id })
    .update({ status: 'assigned', assigned_place_id: placeId, assigned_visit_id: visitId });
  return visitId;
}

// POST /api/notes-review/:id/assign  { placeId, applyToReferrer? }
// Assigns this note (and optionally all pending notes from the same referrer) to a place.
router.post('/:id/assign', async (req, res, next) => {
  try {
    const { placeId, applyToReferrer } = req.body;
    if (!placeId) return res.status(400).json({ error: 'placeId is required' });

    const review = await knex('notes_review').where({ id: req.params.id }).first();
    if (!review) return res.status(404).json({ error: 'Review item not found' });
    const place = await knex('places').where({ id: placeId }).first();
    if (!place) return res.status(404).json({ error: 'Place not found' });

    const result = await knex.transaction(async (trx) => {
      // applyToReferrer batches the whole referrer's pending backlog into one action,
      // so you don't have to resolve each note from the same person one at a time.
      const targets = applyToReferrer
        ? await trx('notes_review').where({ referrer_raw: review.referrer_raw, status: 'pending' })
        : [review];
      let n = 0;
      for (const row of targets) {
        await assignRowToPlace(trx, row, placeId);
        n += 1;
      }
      return n;
    });
    res.json({ assigned: result, place: place.name });
  } catch (err) {
    next(err);
  }
});

// POST /api/notes-review/:id/create-place  { name, category, tier, city, zip, address, applyToReferrer? }
// Creates a place from the referrer, then assigns the note(s) to it. Used
// when the referrer turns out to be a real place that just wasn't in the
// original Excel import.
router.post('/:id/create-place', async (req, res, next) => {
  try {
    const review = await knex('notes_review').where({ id: req.params.id }).first();
    if (!review) return res.status(404).json({ error: 'Review item not found' });

    const { priorityScore, regionForPlace } = require('../services/priority');
    const { name, category, tier, is_priority, city, zip, address, applyToReferrer } = req.body;
    const placeName = (name || review.referrer_raw).trim(); // default to the raw referrer text
    const t = Number(tier) || 3;
    const pri = !!is_priority;

    const result = await knex.transaction(async (trx) => {
      const [pRow] = await trx('places')
        .insert({
          name: placeName,
          category: category || null,
          tier: t,
          is_priority: pri,
          priority_score: priorityScore(t, pri),
          address: address || null,
          city: city || null,
          state: 'NE',
          zip: zip || null,
          region: regionForPlace({ city, zip }),
        })
        .returning('id');
      const placeId = pRow && pRow.id ? pRow.id : pRow;

      const targets = applyToReferrer
        ? await trx('notes_review').where({ referrer_raw: review.referrer_raw, status: 'pending' })
        : [review];
      for (const row of targets) await assignRowToPlace(trx, row, placeId);

      return { placeId, assigned: targets.length };
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/notes-review/:id/dismiss  { applyToReferrer? } — set notes aside
// without importing them (e.g. the referrer is a person, not a place, and
// isn't worth tracking as a place).
router.post('/:id/dismiss', async (req, res, next) => {
  try {
    const review = await knex('notes_review').where({ id: req.params.id }).first();
    if (!review) return res.status(404).json({ error: 'Review item not found' });
    const q = knex('notes_review');
    if (req.body.applyToReferrer) q.where({ referrer_raw: review.referrer_raw, status: 'pending' });
    else q.where({ id: review.id });
    const n = await q.update({ status: 'dismissed' });
    res.json({ dismissed: n });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
