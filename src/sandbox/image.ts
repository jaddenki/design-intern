// The sandbox image holds Node, the Infisical CLI and the app's npm dependencies
// at the lockfile's versions. The app's own code ships per run as a small tarball,
// so a code change never rebuilds the image.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Image, ModalClient } from "modal";
import { APP_ROOT, USE_FIXTURES } from "../config.js";

export const SANDBOX_USER = "user";
export const APP_DIR = "/opt/design-intern";
// anthropics/claude-agent-sdk-typescript#296: the resolver picks the wrong binary on glibc.
export const CLAUDE_BINARY = `${APP_DIR}/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`;

const NODE_IMAGE = "node:24-bookworm-slim";
// 0.44.8+ starts a proxy from a reusable proxy token, with no enrollment step.
export const INFISICAL_CLI_VERSION = "0.44.8";
const HOST_ONLY = new Set(["modal"]);

/** `name@version` for each runtime dependency, pinned to package-lock.json. */
export function pinnedDependencies(root = APP_ROOT): string[] {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string }>;
  };
  return Object.keys(pkg.dependencies)
    .filter((name) => !HOST_ONLY.has(name))
    .map((name) => {
      const version = lock.packages[`node_modules/${name}`]?.version;
      if (!version) throw new Error(`${name} is missing from package-lock.json; run npm install`);
      return `${name}@${version}`;
    })
    .sort();
}

export function sandboxImage(modal: ModalClient): Image {
  return modal.images.fromRegistry(NODE_IMAGE).dockerfileCommands([
    "RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*",
    // The CLI's preinstall downloads the binary; newer npm skips scripts unless allowed.
    `RUN npm install -g --allow-scripts=@infisical/cli @infisical/cli@${INFISICAL_CLI_VERSION} && npm cache clean --force && infisical --version`,
    `RUN useradd --create-home --uid 2000 --shell /bin/bash ${SANDBOX_USER}`,
    `RUN mkdir -p ${APP_DIR} && cd ${APP_DIR} && echo '{"private":true,"type":"module"}' > package.json && ` +
      `npm install --omit=dev --no-audit --no-fund ${pinnedDependencies().join(" ")} && npm cache clean --force && ` +
      `test -x ${CLAUDE_BINARY}`,
  ]);
}

// fixtures/ ships only for the eval.
const bundled = () => ["package.json", "dist", "knowledge", "mcp-servers.json", ...(USE_FIXTURES ? ["fixtures"] : [])];

/** Tars the compiled app for one run. Needs `npm run build` first. */
export function appBundle(): string {
  if (!existsSync(path.join(APP_ROOT, "dist/sandbox/entry.js"))) {
    throw new Error("dist/sandbox/entry.js is missing; run `npm run build` first.");
  }
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "design-intern-")), "app.tgz");
  // COPYFILE_DISABLE keeps macOS tar from adding ._ resource files.
  execFileSync("tar", ["-czf", file, "-C", APP_ROOT, ...bundled().filter((p) => existsSync(path.join(APP_ROOT, p)))], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return file;
}
