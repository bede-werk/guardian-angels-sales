const knex = require('../db/knex');

// Express middleware that protects a router: requires a valid
// `Authorization: Bearer <token>` header matching a user's current session
// token (see services/auth.js for how that token gets created at login).
// On success it attaches the logged-in user as req.user for the route handler
// to use; on failure it responds 401 and never calls the actual route.
module.exports = async function requireAuth(req, res, next) {
  // Pull the token out of "Authorization: Bearer <token>". No header, or the
  // wrong format, means no token to check.
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    // A user "has a session" simply by having this exact token stored on
    // their row (users.auth_token). Login/logout/change-password are what set
    // or clear that column — see routes/auth.js.
    const user = await knex('users').where({ auth_token: token }).first();
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    req.user = user; // downstream route handlers read req.user.id / req.user.name
    next(); // token is valid — let the request continue to the real route
  } catch (err) {
    next(err); // unexpected error (e.g. DB down) — hand off to the error handler in index.js
  }
};
