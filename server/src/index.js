// Guardian Angels Homecare — Sales Visit Scheduling API.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const knex = require('./db/knex');
const { importPartners } = require('./scripts/import-excel');
const { importNotes } = require('./scripts/import-notes');

const partners = require('./routes/partners');
const visits = require('./routes/visits');
const schedule = require('./routes/schedule');
const dashboard = require('./routes/dashboard');
const users = require('./routes/users');
const notesReview = require('./routes/notesReview');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'ga-sales-api' }));

app.use('/api/partners', partners);
app.use('/api/visits', visits);
app.use('/api/schedule', schedule);
app.use('/api/dashboard', dashboard);
app.use('/api/users', users);
app.use('/api/notes-review', notesReview);

// In production, serve the built React app so a single service can host both.
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
  app.use(express.static(clientDist));
  // SPA fallback (Express 5 rejects the bare '*' path string, so use middleware).
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Centralized error handler.
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
    const { c } = await knex('partners').count({ c: '*' }).first();
    if (Number(c) === 0) {
      console.log('Empty database detected — seeding from bundled spreadsheets…');
      await importPartners();
      await importNotes();
      console.log('Seeding complete.');
    }
  } catch (err) {
    console.error('Auto-seed failed (server still running):', err.message);
  }
}

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

module.exports = app;
