import { vi } from "vitest";
import { register } from "prom-client";

// Vitest reloads source modules between files while prom-client's CJS registry is shared.
register.clear();

// Provider I/O alone is mocked. Sequelize, pg, redis, migrations and Room stores are real.
vi.mock("../../infoextractor.js", () => ({ default: {} }));
