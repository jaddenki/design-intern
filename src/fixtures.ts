// Eval and tests only (DATA_SOURCE=fixtures): each client reads raw records from fixtures/
// instead of the live API, then runs the same scope filters it uses in production.
import { readFileSync } from "node:fs";
import path from "node:path";
import { APP_ROOT } from "./config.js";

const FIXTURE_DIR = path.join(APP_ROOT, "fixtures");

export function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8")) as T;
}

interface FixtureMeta {
  now: string;
  env: Record<string, string>;
}

/** Fixed clock so the eval week always lines up with the fixture data. */
export function fixtureNow(): Date {
  return new Date(loadFixture<FixtureMeta>("meta").now);
}

/** Scope config for the eval week; real env values win so tests can override. */
export function applyFixtureEnv(): void {
  for (const [key, value] of Object.entries(loadFixture<FixtureMeta>("meta").env)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
