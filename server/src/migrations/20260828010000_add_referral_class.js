// The payer source a referral came in under - Bede's term for it is "class",
// which is what eRSP calls it, so that's the column name rather than a
// invented synonym like payer_source.
//
// Free text, not a foreign key to a lookup table. The vocabulary lives in
// eRSP, not here, and the values arrive with the one-time migration - locking
// the column to a list we'd have to guess at would mean an import that
// rejects real data. routes/referrals.js exposes the distinct values already
// on file so the form can suggest them (see GET /referrals/classes), which
// keeps spelling consistent without refusing anything new. If the set later
// proves genuinely fixed, promoting it to a table like `categories` is a
// small follow-up.
//
// NULL on every existing row and on anything logged without one: "nobody
// recorded a payer source" is a real answer and shouldn't be dressed up as
// one. Nothing in the app filters or scores on this yet - it's captured now
// so the history exists to report on later.
exports.up = async function up(knex) {
  await knex.schema.alterTable('referrals', (t) => {
    t.text('class');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('referrals', (t) => {
    t.dropColumn('class');
  });
};
