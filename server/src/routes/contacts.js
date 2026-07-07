const express = require('express');
const knex = require('../db/knex');

const router = express.Router();

const ROLE_TYPES = ['decision_maker', 'gatekeeper', 'champion', 'other'];
const TEMPS = ['hot', 'warm', 'cold', 'dormant'];

// Fields a client is allowed to set on a contact.
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

function validate(payload) {
  if (payload.role_type && !ROLE_TYPES.includes(payload.role_type)) {
    return `role_type must be one of ${ROLE_TYPES.join(', ')}`;
  }
  if (payload.relationship_temp && !TEMPS.includes(payload.relationship_temp)) {
    return `relationship_temp must be one of ${TEMPS.join(', ')}`;
  }
  return null;
}

// Only one contact per partner can be primary at a time.
async function unsetOtherPrimaries(trx, partnerId, keepId) {
  await trx('contacts').where({ partner_id: partnerId }).whereNot({ id: keepId }).update({ is_primary: false });
}

// GET /api/partners/:partnerId/contacts — a partner's people, primary first.
router.get('/partners/:partnerId/contacts', async (req, res, next) => {
  try {
    const contacts = await knex('contacts')
      .where({ partner_id: req.params.partnerId })
      .orderBy('is_primary', 'desc')
      .orderBy('name', 'asc');
    res.json(contacts.map((c) => ({ ...c, departed: !!c.departed, is_primary: !!c.is_primary })));
  } catch (err) {
    next(err);
  }
});

// POST /api/partners/:partnerId/contacts — add a person at this place.
router.post('/partners/:partnerId/contacts', async (req, res, next) => {
  try {
    const partnerId = req.params.partnerId;
    const partner = await knex('partners').where({ id: partnerId }).first();
    if (!partner) return res.status(404).json({ error: 'Partner not found' });

    const { name } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });

    const payload = { partner_id: partnerId, name: String(name).trim() };
    for (const f of EDITABLE) if (f !== 'name' && req.body[f] !== undefined) payload[f] = req.body[f];

    const validationError = validate(payload);
    if (validationError) return res.status(400).json({ error: validationError });

    const contact = await knex.transaction(async (trx) => {
      const [inserted] = await trx('contacts').insert(payload).returning('id');
      const id = inserted && inserted.id ? inserted.id : inserted;
      if (payload.is_primary) await unsetOtherPrimaries(trx, partnerId, id);
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
      if (update.is_primary) await unsetOtherPrimaries(trx, existing.partner_id, req.params.id);
      return trx('contacts').where({ id: req.params.id }).first();
    });

    res.json({ ...contact, departed: !!contact.departed, is_primary: !!contact.is_primary });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/contacts/:id
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
