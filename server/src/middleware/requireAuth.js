const knex = require('../db/knex');

// Protects a router: requires a valid `Authorization: Bearer <token>` header
// matching a user's current session token. Attaches the user as req.user.
module.exports = async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const user = await knex('users').where({ auth_token: token }).first();
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};
