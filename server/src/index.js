// Guardian Angels Homecare — Sales Visit Scheduling API.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const partners = require('./routes/partners');
const visits = require('./routes/visits');
const schedule = require('./routes/schedule');
const dashboard = require('./routes/dashboard');
const users = require('./routes/users');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'ga-sales-api' }));

app.use('/api/partners', partners);
app.use('/api/visits', visits);
app.use('/api/schedule', schedule);
app.use('/api/dashboard', dashboard);
app.use('/api/users', users);

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
app.listen(PORT, () => {
  console.log(`GA Sales API listening on http://localhost:${PORT}`);
});

module.exports = app;
