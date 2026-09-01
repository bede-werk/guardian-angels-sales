const knex = require('../db/knex');

// How stale a session's last_seen_at may get before requireAuth refreshes it.
// Bounds the tracking write to at most once per active session per hour rather
// than one on every API request.
const LAST_SEEN_REFRESH_MS = 60 * 60 * 1000;

// Express middleware that protects a router: requires a valid
// `Authorization: Bearer <token>` header naming a live row in `sessions`
// (see routes/auth.js for how those rows get created at login and cleared on
// logout / change-password).
// On success it attaches the logged-in user as req.user and the session row as
// req.session for the route handler; on failure it responds 401 and never
// calls the actual route.
module.exports = async function requireAuth(req, res, next) {
  // Pull the token out of "Authorization: Bearer <token>". No header, or the
  // wrong format, means no token to check.
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    // A token is valid as long as it names a session row. Each user can have
    // many - one per device they've logged in on - so signing in somewhere new
    // no longer signs the other places out.
    const session = await knex('sessions').where({ token }).first();
    if (!session) return res.status(401).json({ error: 'Not authenticated' });

    const user = await knex('users').where({ id: session.user_id }).first();
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    // Cheap "last active" tracking for a future active-sessions view - skipped
    // on most requests so it isn't a write on every API call.
    const lastSeen = session.last_seen_at ? new Date(session.last_seen_at).getTime() : 0;
    if (Date.now() - lastSeen > LAST_SEEN_REFRESH_MS) {
      await knex('sessions').where({ id: session.id }).update({ last_seen_at: knex.fn.now() });
    }

    req.user = user; // downstream route handlers read req.user.id / req.user.name
    req.session = session; // routes/auth.js's logout deletes exactly this row
    next(); // token is valid - let the request continue to the real route
  } catch (err) {
    next(err); // unexpected error (e.g. DB down) - hand off to the error handler in index.js
  }
};
