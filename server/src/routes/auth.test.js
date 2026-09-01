// Route-level test for the sessions table (migration 20260901000000): logging
// in on a second device must NOT sign the first one out, logout must only end
// the calling device's session, and change-password must end all of them.
//
// Same require-cache-substitution harness as routes/places.test.js - see that
// file's header for why it's necessary (routes/auth.js and
// middleware/requireAuth.js both do `const knex = require('../db/knex')` at
// module load time, no injectable `db` param).
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const knexLib = require('knex');
const express = require('express');

const dbKnexPath = require.resolve('../db/knex');
const testKnex = knexLib({
  client: 'better-sqlite3',
  connection: { filename: ':memory:' },
  useNullAsDefault: true,
  migrations: { directory: path.join(__dirname, '..', 'migrations') },
  pool: {
    afterCreate: (conn, done) => {
      conn.pragma('foreign_keys = ON');
      done(null, conn);
    },
  },
});

require.cache[dbKnexPath] = {
  id: dbKnexPath,
  filename: dbKnexPath,
  loaded: true,
  exports: testKnex,
};

const authRouter = require('./auth');

let server;
let baseUrl;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  // A protected probe route so tests can check whether a token still works.
  const requireAuth = require('../middleware/requireAuth');
  app.get('/api/protected', requireAuth, (req, res) => res.json({ userId: req.user.id }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message || 'Internal server error' }));
  return app;
}

before(async () => {
  await testKnex.migrate.latest();
  const app = buildApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testKnex.destroy();
});

beforeEach(async () => {
  await testKnex('sessions').del();
  await testKnex('users').del();
  await testKnex('users').insert({ id: 1, name: 'Rep A', email: 'a@test.local' });
});

const post = (pathname, body, token) =>
  fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const getProtected = (token) =>
  fetch(`${baseUrl}/api/protected`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

async function setPassword(pw = 'secret1') {
  const res = await post('/api/auth/set-password', { userId: 1, newPassword: pw });
  return (await res.json()).token;
}
async function login(pw = 'secret1') {
  const res = await post('/api/auth/login', { userId: 1, password: pw });
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

describe('sessions: multi-device auth', () => {
  test('logging in on a second device leaves the first device logged in', async () => {
    await setPassword();
    const deviceA = await login();
    const deviceB = await login();

    assert.notEqual(deviceA, deviceB);
    assert.equal((await getProtected(deviceA)).status, 200);
    assert.equal((await getProtected(deviceB)).status, 200);
    // 3 = the two logins here + the session set-password itself issued.
    assert.equal(await testKnex('sessions').where({ user_id: 1 }).count('* as c').then((r) => r[0].c), 3);
  });

  test('logout ends only the calling device', async () => {
    await setPassword();
    const deviceA = await login();
    const deviceB = await login();

    const res = await post('/api/auth/logout', {}, deviceA);
    assert.equal(res.status, 204);

    assert.equal((await getProtected(deviceA)).status, 401);
    assert.equal((await getProtected(deviceB)).status, 200);
  });

  test('change-password ends every session, then hands the caller a fresh one', async () => {
    await setPassword('secret1');
    const deviceA = await login('secret1');
    const deviceB = await login('secret1');

    const res = await post('/api/auth/change-password', { currentPassword: 'secret1', newPassword: 'secret2' }, deviceA);
    assert.equal(res.status, 200);
    const fresh = (await res.json()).token;

    assert.equal((await getProtected(deviceA)).status, 401);
    assert.equal((await getProtected(deviceB)).status, 401);
    assert.equal((await getProtected(fresh)).status, 200);
    assert.equal(await testKnex('sessions').where({ user_id: 1 }).count('* as c').then((r) => r[0].c), 1);
  });

  test('set-password issues a working session', async () => {
    const token = await setPassword();
    assert.equal((await getProtected(token)).status, 200);
  });

  test('a garbage token is rejected', async () => {
    assert.equal((await getProtected('not-a-real-token')).status, 401);
  });
});
