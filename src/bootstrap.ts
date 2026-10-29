// Import first in every entry point: loads .env, then the eval week's scope config if DATA_SOURCE=fixtures.
import "dotenv/config";
import { USE_FIXTURES } from "./config.js";
import { applyFixtureEnv } from "./fixtures.js";

if (USE_FIXTURES) applyFixtureEnv();
