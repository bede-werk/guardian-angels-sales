// Manage the canonical list of place categories — promoted from a hardcoded
// config/categories.js enum (see migration 20260727000000) to a real table so
// it can be edited from the app instead of needing a code change/redeploy
// every time the business needs a new one.
const express = require('express');
const knex = require('../db/knex');

const router = express.Router();

// GET /api/categories — every category, alphabetical, with how many places
// currently use each (so the "manage categories" UI can warn before a
// delete that would affect real data).
router.get('/', async (req, res, next) => {
  try {
    const rows = await knex('categories as c')
      .leftJoin('places as p', 'p.category', 'c.name')
      .groupBy('c.id', 'c.name')
      .orderBy('c.name')
      .select('c.id', 'c.name')
      .count('p.id as place_count');
    res.json(rows.map((r) => ({ ...r, place_count: Number(r.place_count) || 0 })));
  } catch (err) {
    next(err);
  }
});

// POST /api/categories — add a new one.
router.post('/', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const dup = await knex('categories').whereRaw('LOWER(name) = LOWER(?)', [name]).first();
    if (dup) return res.status(400).json({ error: 'That category already exists' });
    const [row] = await knex('categories').insert({ name }).returning('id');
    const id = knex.extractId(row);
    res.status(201).json(await knex('categories').where({ id }).first());
  } catch (err) {
    next(err);
  }
});

// PATCH /api/categories/:id — rename. Cascades to every place currently
// using the old name so the taxonomy and the actual data never diverge —
// unlike deleting a place/person, a category rename isn't a historical
// record, it's just relabeling a classification value.
router.patch('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await knex('categories').where({ id }).first();
    if (!existing) return res.status(404).json({ error: 'Category not found' });
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const dup = await knex('categories').whereRaw('LOWER(name) = LOWER(?)', [name]).andWhereNot({ id }).first();
    if (dup) return res.status(400).json({ error: 'That category already exists' });
    await knex.transaction(async (trx) => {
      await trx('categories').where({ id }).update({ name });
      if (existing.name !== name) await trx('places').where({ category: existing.name }).update({ category: name });
    });
    res.json(await knex('categories').where({ id }).first());
  } catch (err) {
    next(err);
  }
});

// DELETE /api/categories/:id — retire a category. Any place currently using
// it isn't blocked or destroyed — it falls back to uncategorized (category =
// null, already a normal state for a place), matching this app's
// detach-not-destroy convention for removing a referenced value.
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await knex('categories').where({ id }).first();
    if (!existing) return res.status(404).json({ error: 'Category not found' });
    let affectedPlaces = 0;
    await knex.transaction(async (trx) => {
      affectedPlaces = await trx('places').where({ category: existing.name }).update({ category: null });
      await trx('categories').where({ id }).del();
    });
    res.json({ deleted: true, affectedPlaces });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
