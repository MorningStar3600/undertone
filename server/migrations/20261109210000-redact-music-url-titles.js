"use strict";

const URL_TITLE = /^\s*https?:\/\//i;

/** URL fallback titles may contain playback credentials. Keep source references intact,
 * but redact existing public titles. Do not restore sensitive titles on rollback. */
module.exports = {
	async up(q, S) {
		await q.sequelize.transaction(async transaction => {
			for (let offset = 0; ; offset += 500) {
				const rows = await q.sequelize.query(
					'SELECT "id", "title" FROM "Tracks" ORDER BY "id" LIMIT 500 OFFSET :offset',
					{ replacements: { offset }, type: S.QueryTypes.SELECT, transaction },
				);
				for (const row of rows) {
					if (URL_TITLE.test(row.title)) {
						await q.bulkUpdate(
							"Tracks",
							{ title: "Untitled track" },
							{ id: row.id },
							{ transaction },
						);
					}
				}
				if (rows.length < 500) {
					break;
				}
			}
		});
	},
	async down() {
		// Intentionally irreversible redaction; original private references are not duplicated.
	},
};
