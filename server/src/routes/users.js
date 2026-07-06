const express = require('express');
const knex = require('../db/knex');

const router = express.Router();

// List team members.
router.get('/', async (req, res, next) => {
  try {
    const users = await knex('users').orderBy('name');
    res.json(users);
  } catch (err) {
    next(err);
  }
});

// Create a team member.
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
