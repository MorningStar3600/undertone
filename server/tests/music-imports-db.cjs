// eslint-disable-next-line @typescript-eslint/no-var-requires -- Sequelize CLI loads CommonJS configs.
const path = require("node:path");

if (process.env.NODE_ENV !== "test" || process.env.DB_MODE !== "sqlite") {
	throw new Error("Migration verification requires NODE_ENV=test DB_MODE=sqlite.");
}

// Explicit CLI config avoids loading any private application configuration.
module.exports = {
	test: {
		dialect: "sqlite",
		storage: path.resolve(__dirname, "../db/test.sqlite"),
		logging: false,
	},
};
