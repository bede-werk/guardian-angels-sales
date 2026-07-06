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

    // Group by referrer for the UI.
    const groups = {};
    for (const r of rows) {
      if (!groups[r.referrer_raw]) groups[r.referrer_raw] = { referrer: r.referrer_raw, notes: [] };
      groups[r.referrer_raw].notes.push(r);
    }
    res.json({
      count: rows.length,
      referrer_count: Object.keys(groups).length,
      groups: Object.values(groups).sort((a, b) => b.notes.length - a.notes.length),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/notes-review/count — pending count (for the tab badge).
router.get('/count', async (req, res, next) => {
  try {
    const row = await knex('notes_review').where({ status: 'pending' }).count({ c: '*' }).first();
    res.json({ pending: Number(row.c) });
  } catch (err) {
    next(err);
  }
});

// Convert one review row into a completed visit on a partner.
async function assignRowToPartner(trx, review, partnerId) {
  const [row] = await trx('visits')
    .insert({
      partner_id: partnerId,
      user_id: review.author_user_id || null,
      scheduled_date: review.note_date,
      status: 'completed',
      source: 'imported_note',
      notes: review.note_text,
      completed_at: review.note_date ? `${review.note_date} 12:00:00` : trx.fn.now(),
    })
    .returning('id');
  const visitId = row && row.id ? row.id : row;
  await trx('notes_review')
    .where({ id: review.id })
    .update({ status: 'assigned', assigned_partner_id: partnerId, assigned_visit_id: visitId });
  return visitId;
}

// POST /api/notes-review/:id/assign  { partnerId, applyToReferrer? }
// Assigns this note (and optionally all pending notes from the same referrer) to a partner.
router.post('/:id/assign', async (req, res, next) => {
  try {
    const { partnerId, applyToReferrer } = req.body;
    if (!partnerId) return res.status(400).json({ error: 'partnerId is required' });

    const review = await knex('notes_review').where({ id: req.params.id }).first();
    if (!review) return res.status(404).json({ error: 'Review item not found' });
    const partner = await knex('partners').where({ id: partnerId }).first();
    if (!partner) return res.status(404).json({ error: 'Partner not found' });

    const result = await knex.transaction(async (trx) => {
      const targets = applyToReferrer
        ? await trx('notes_review').where({ referrer_raw: review.referrer_raw, status: 'pending' })
        : [review];
      let n = 0;
      for (const row of targets) {
        await assignRowToPartner(trx, row, partnerId);
        n += 1;
      }
      return n;
    });
    res.json({ assigned: result, partner: partner.name });
  } catch (err) {
    next(err);
  }
});

// POST /api/notes-review/:id/create-partner  { name, category, tier, city, zip, address, applyToReferrer? }
// Creates a partner from the referrer, then assigns the note(s) to it.
router.post('/:id/create-partner', async (req, res, next) => {
  try {
    const review = await knex('notes_review').where({ id: req.params.id }).first();
    if (!review) return res.status(404).json({ error: 'Review item not found' });

    const { priorityScore, regionForPartner } = require('../services/priority');
    const { name, category, tier, is_priority, city, zip, address, applyToReferrer } = req.body;
    const partnerName = (name || review.referrer_raw).trim();
    const t = Number(tier) || 3;
    const pri = !!is_priority;

    const result = await knex.transaction(async (trx) => {
      const [pRow] = await trx('partners')
        .insert({
          name: partnerName,
          category: category || null,
          tier: t,
          is_priority: pri,
          priority_score: priorityScore(t, pri),
          address: address || null,
          city: city || null,
          state: 'NE',
          zip: zip || null,
          region: regionForPartner({ city, zip }),
        })
        .returning('id');
      const partnerId = pRow && pRow.id ? pRow.id : pRow;

      const targets = applyToReferrer
        ? await trx('notes_review').where({ referrer_raw: review.referrer_raw, status: 'pending' })
        : [review];
      for (const row of targets) await assignRowToPartner(trx, row, partnerId);

      return { partnerId, assigned: targets.length };
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/notes-review/:id/dismiss  { applyToReferrer? } — set notes aside without importing.
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
