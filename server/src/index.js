// Guardian Angels Homecare — Sales Visit Scheduling API.
// This is the entry point: it wires together the Express app, mounts every
// route module under /api/*, and starts the HTTP server.
require('dotenv').config(); // loads server/.env into process.env
const express = require('express');
const cors = require('cors');
const path = require('path');
const knex = require('./db/knex');
const { importPlaces } = require('./scripts/import-excel');
const { importNotes } = require('./scripts/import-notes');

// Each of these files is an Express Router handling one resource/area of the API.
const places = require('./routes/places');
const visits = require('./routes/visits');
const schedule = require('./routes/schedule');
const dashboard = require('./routes/dashboard');
const users = require('./routes/users');
const notesReview = require('./routes/notesReview');
const contacts = require('./routes/contacts');
const auth = require('./routes/auth');
const requireAuth = require('./middleware/requireAuth'); // blocks a request unless it has a valid login token

const app = express();
app.use(cors()); // allow the frontend (different port in dev) to call this API
app.use(express.json()); // parse JSON request bodies into req.body

// Simple health check — used by Railway/Heroku to confirm the server is alive.
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'ga-sales-api' }));

// Auth routes are intentionally NOT behind requireAuth — you need to be able to
// hit /api/auth/login before you have a token to prove who you are.
app.use('/api/auth', auth);

// Every other route below requires a valid login token (see middleware/requireAuth.js).
app.use('/api/places', requireAuth, places);
app.use('/api/visits', requireAuth, visits);
app.use('/api/schedule', requireAuth, schedule);
app.use('/api/dashboard', requireAuth, dashboard);
app.use('/api/users', requireAuth, users);
app.use('/api/notes-review', requireAuth, notesReview);
// contacts.js defines its own full paths (/places/:id/contacts and /contacts/:id),
// so it's mounted at the bare '/api' prefix rather than a single resource prefix.
app.use('/api', requireAuth, contacts);

// In production, serve the built React app so a single service can host both.
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
  app.use(express.static(clientDist));
  // SPA fallback (Express 5 rejects the bare '*' path string, so use middleware).
  // Any GET that isn't an API call and doesn't match a static file gets index.html,
  // so React Router / client-side navigation works on a hard page refresh.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Centralized error handler. Any route that calls next(err) (see the routes'
// try/catch blocks) ends up here instead of crashing the server.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
const isProd = process.env.NODE_ENV === 'production';

// On first boot with an empty database, load the bundled spreadsheets.
// Runs in the background after the server is already listening, so the app
// comes up immediately and Railway's health check passes.
async function seedIfEmpty() {
  try {
    const { c } = await knex('places').count({ c: '*' }).first();
    if (Number(c) === 0) {
      console.log('Empty database detected — seeding from bundled spreadsheets…');
      await importPlaces();
      await importNotes();
      console.log('Seeding complete.');
    }
  } catch (err) {
    console.error('Auto-seed failed (server still running):', err.message);
  }
}

// Boots the server: runs migrations (production only), starts listening, then
// kicks off the background auto-seed (production only, and only if empty).
async function start() {
  // In production the database is only reachable at runtime (not during the build),
  // so migrations run here rather than in a build/pre-deploy step.
  if (isProd) {
    console.log('Running database migrations…');
    await knex.migrate.latest();
  }
  app.listen(PORT, () => {
    console.log(`GA Sales API listening on http://localhost:${PORT}`);
    if (isProd) seedIfEmpty();
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

module.exports = app; // exported mainly so tests could import the app without starting a real server
