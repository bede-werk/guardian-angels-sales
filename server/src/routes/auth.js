const express = require('express');
const knex = require('../db/knex');
const requireAuth = require('../middleware/requireAuth');
const { hashPassword, verifyPassword, generateToken } = require('../services/auth');

const router = express.Router();
const MIN_PASSWORD_LENGTH = 6;

function publicUser(user) {
  return { id: user.id, name: user.name };
}

// GET /api/auth/users — for the login picker. Never exposes the password hash.
router.get('/users', async (req, res, next) => {
  try {
    const rows = await knex('users').select('id', 'name', 'password_hash').orderBy('name');
    res.json(rows.map((u) => ({ id: u.id, name: u.name, hasPassword: !!u.password_hash })));
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/set-password — first-time password creation for a user that
// doesn't have one yet. Logs them in immediately.
router.post('/set-password', async (req, res, next) => {
  try {
    const { userId, newPassword } = req.body;
    if (!userId || !newPassword) return res.status(400).json({ error: 'userId and newPassword are required' });
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const user = await knex('users').where({ id: userId }).first();
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.password_hash) return res.status(400).json({ error: 'Password already set — log in instead' });

    const password_hash = await hashPassword(newPassword);
    const auth_token = generateToken();
    await knex('users').where({ id: userId }).update({ password_hash, auth_token });
    res.json({ token: auth_token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { userId, password } = req.body;
    if (!userId || !password) return res.status(400).json({ error: 'userId and password are required' });

    const user = await knex('users').where({ id: userId }).first();
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.password_hash) return res.status(400).json({ error: 'No password set yet — create one first' });

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect password' });

    const auth_token = generateToken();
    await knex('users').where({ id: userId }).update({ auth_token });
    res.json({ token: auth_token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me — restore a session after a page reload.
router.get('/me', requireAuth, (req, res) => {
  res.json(publicUser(req.user));
});

// POST /api/auth/change-password — rotates the token, so other signed-in
// devices are signed out; the caller gets the new token back to stay signed in.
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const ok = await verifyPassword(currentPassword, req.user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    const password_hash = await hashPassword(newPassword);
    const auth_token = generateToken();
    await knex('users').where({ id: req.user.id }).update({ password_hash, auth_token });
    res.json({ token: auth_token, user: publicUser(req.user) });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await knex('users').where({ id: req.user.id }).update({ auth_token: null });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
