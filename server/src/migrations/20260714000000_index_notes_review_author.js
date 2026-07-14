// notesReview.js's GET / (the "needs mapping" screen) left-joins users on
// author_user_id for every list fetch, with no index backing that join —
// missed on the original 20260706010000_notes_import.js migration, which
// only indexed status. Low-traffic table (a few dozen unmatched-import
// rows), so this is a correctness/consistency fix more than a real
// performance need today.
exports.up = async function up(knex) {
  await knex.schema.alterTable('notes_review', (t) => {
    t.index('author_user_id', 'notes_review_author_user_id_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('notes_review', (t) => {
    t.dropIndex('author_user_id', 'notes_review_author_user_id_index');
  });
};
