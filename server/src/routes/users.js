// Team members. Note: this is separate from auth (routes/auth.js) — a "user"
// row here just represents a person on the sales team; login/password/session
// concerns live in the auth routes even though they also touch this same table.
const express = require('express');
const knex = require('../db/knex');

const router = express.Router();

// GET /api/users — list team members, alphabetically.
router.get('/', async (req, res, next) => {
  try {
    const users = await knex('users').orderBy('name');
    res.json(users);
  } catch (err) {
    next(err);
  }
});

// POST /api/users — add a new team member (no password yet — they set one
// themselves the first time they log in, see routes/auth.js's set-password).
router.post('/', async (req, res, next) => {
  try {
    const { name, email } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const [row] = await knex('users').insert({ name, email }).returning('*');
    // better-sqlite3 returning() may yield an id only; re-fetch for consistency.
    const user = row && row.name ? row : await knex('users').where({ id: row.id || row }).first();
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
