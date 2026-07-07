// Contacts ("people") CRUD — every contact belongs to exactly one place.
// Mounted at the bare /api prefix in index.js because these routes define
// their own full paths (some nest under /places/:placeId, some don't),
// rather than all sharing one /api/contacts prefix.
const express = require('express');
const knex = require('../db/knex');

const router = express.Router();

const ROLE_TYPES = ['decision_maker', 'gatekeeper', 'champion', 'other'];
const TEMPS = ['hot', 'warm', 'cold', 'dormant'];

// Fields a client is allowed to set on a contact (mirrors the `contacts` migration).
const EDITABLE = [
  'name',
  'title',
  'role_type',
  'email',
  'phone',
  'relationship_temp',
  'preferences',
  'notes',
  'birthday',
  'departed',
  'is_primary',
];

// Checks the enum-like fields against their allowed values. Returns an error
// string to send back to the client, or null if everything's valid.
function validate(payload) {
  if (payload.role_type && !ROLE_TYPES.includes(payload.role_type)) {
    return `role_type must be one of ${ROLE_TYPES.join(', ')}`;
  }
  if (payload.relationship_temp && !TEMPS.includes(payload.relationship_temp)) {
    return `relationship_temp must be one of ${TEMPS.join(', ')}`;
  }
  return null;
}

// Only one contact per place can be primary at a time. Called whenever a
// create/update sets is_primary=true, so the previous primary (if any) is
// automatically demoted in the same transaction.
async function unsetOtherPrimaries(trx, placeId, keepId) {
  await trx('contacts').where({ place_id: placeId }).whereNot({ id: keepId }).update({ is_primary: false });
}

// GET /api/places/:placeId/contacts — a place's people, primary first.
router.get('/places/:placeId/contacts', async (req, res, next) => {
  try {
    const contacts = await knex('contacts')
      .where({ place_id: req.params.placeId })
      .orderBy('is_primary', 'desc')
      .orderBy('name', 'asc');
    // SQLite stores booleans as 0/1 — coerce them back to real booleans for the API.
    res.json(contacts.map((c) => ({ ...c, departed: !!c.departed, is_primary: !!c.is_primary })));
  } catch (err) {
    next(err);
  }
});

// POST /api/places/:placeId/contacts — add a person at this place.
router.post('/places/:placeId/contacts', async (req, res, next) => {
  try {
    const placeId = req.params.placeId;
    const place = await knex('places').where({ id: placeId }).first();
    if (!place) return res.status(404).json({ error: 'Place not found' });

    const { name } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });

    const payload = { place_id: placeId, name: String(name).trim() };
    for (const f of EDITABLE) if (f !== 'name' && req.body[f] !== undefined) payload[f] = req.body[f];

    const validationError = validate(payload);
    if (validationError) return res.status(400).json({ error: validationError });

    const contact = await knex.transaction(async (trx) => {
      const [inserted] = await trx('contacts').insert(payload).returning('id');
      // better-sqlite3's returning() gives back an id-only row on some Knex
      // versions; Postgres gives the full row. Normalize to just the id here.
      const id = inserted && inserted.id ? inserted.id : inserted;
      if (payload.is_primary) await unsetOtherPrimaries(trx, placeId, id);
      return trx('contacts').where({ id }).first();
    });

    res.status(201).json({ ...contact, departed: !!contact.departed, is_primary: !!contact.is_primary });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/contacts/:id — update any field (role, temperature, departed, etc.).
router.patch('/contacts/:id', async (req, res, next) => {
  try {
    const existing = await knex('contacts').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Contact not found' });

    const update = { updated_at: knex.fn.now() };
    for (const f of EDITABLE) if (req.body[f] !== undefined) update[f] = req.body[f];

    const validationError = validate(update);
    if (validationError) return res.status(400).json({ error: validationError });

    const contact = await knex.transaction(async (trx) => {
      await trx('contacts').where({ id: req.params.id }).update(update);
      if (update.is_primary) await unsetOtherPrimaries(trx, existing.place_id, req.params.id);
      return trx('contacts').where({ id: req.params.id }).first();
    });

    res.json({ ...contact, departed: !!contact.departed, is_primary: !!contact.is_primary });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/contacts/:id — permanently remove a person record. (Note: for
// someone who's simply left their job, prefer PATCHing departed=true instead —
// that keeps their visit history intact and flags the relationship for rebuilding.)
router.delete('/contacts/:id', async (req, res, next) => {
  try {
    const count = await knex('contacts').where({ id: req.params.id }).del();
    if (!count) return res.status(404).json({ error: 'Contact not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
