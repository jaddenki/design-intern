// `make sync-brand`: pulls Infisical's brand into knowledge/brand/ so the agent can
// answer brand questions and hand out logos. Runs on the host. Public sources are
// fetched directly; the private brand repo is read with your own `gh` login.
// knowledge/brand/ is gitignored because this repo is public and the brand repo isn't.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APP_ROOT } from "../src/config.js";

const OUT = path.join(APP_ROOT, "knowledge/brand");
const SITE = "https://infisical-brand.vercel.app";
const DESIGN_MD = "https://infisical.com/design.md";
const BRAND_CSS = "https://infisical.com/infisical-brand.css";
const REPO = "Infisical/infisical-brand";
const MAX_PART_CHARS = 18_000;

const LOGOS = [
  { file: "full_logo", name: "full logo (logomark + wordmark)" },
  { file: "wordmark", name: "wordmark" },
  { file: "logomark", name: "logomark (icon only)" },
];
const COLORWAYS = [
  { suffix: "black", use: "white or Volt (#F7FE62) backgrounds" },
  { suffix: "white", use: "black backgrounds" },
];

async function get(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

function gh(file: string): string {
  return execFileSync("gh", ["api", `repos/${REPO}/contents/${file}`, "--jq", ".content"], { encoding: "utf8" })
    .split("\n")
    .map((l) => Buffer.from(l, "base64").toString("utf8"))
    .join("");
}

function write(rel: string, body: string) {
  const file = path.join(OUT, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  console.log(`  knowledge/brand/${rel} (${body.length.toLocaleString()} chars)`);
}

function isPlainSvg(svg: string): boolean {
  return /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg) && !/<script|on[a-z]+\s*=|javascript:/i.test(svg);
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  console.log("Syncing brand into knowledge/brand/");

  const design = await get(DESIGN_MD);
  write("design-principles.md", `# Infisical design principles (design.md)\n\nSource: ${DESIGN_MD}\n\n${design.replace(/^---[\s\S]*?---\s*/, "")}`);

  // Only the token lines (and their section comments), split to fit the doc limit.
  const tokens = (await get(BRAND_CSS))
    .split("\n")
    .filter((l) => /^\s*(--[\w-]+\s*:|\/\*\s*──)/.test(l))
    .map((l) => l.trim());
  const parts: string[][] = [[]];
  for (const line of tokens) {
    if (parts.at(-1)!.join("\n").length + line.length > MAX_PART_CHARS) parts.push([]);
    parts.at(-1)!.push(line);
  }
  parts.forEach((lines, i) =>
    write(
      `brand-css-${i + 1}.md`,
      `# Brand CSS tokens, part ${i + 1} of ${parts.length}\n\nSource: ${BRAND_CSS} (the canonical web values; every --v2-* custom property the marketing site reads).\n\n\`\`\`css\n${lines.join("\n")}\n\`\`\`\n`,
    ),
  );

  for (const logo of LOGOS) {
    for (const way of COLORWAYS) {
      const base = `${SITE}/assets/logos/${logo.file}_${way.suffix}`;
      const svg = (await get(`${base}.svg`)).trim();
      if (!isPlainSvg(svg)) throw new Error(`${base}.svg isn't a plain SVG; refusing to store it.`);
      write(
        `logos/${logo.file.replace("_", "-")}-${way.suffix}.md`,
        `# Infisical ${logo.name}, ${way.suffix} (SVG logo)\n\nUse the ${way.suffix} ${logo.name} on ${way.use}.\n\n- SVG: ${base}.svg\n- PNG: ${base}.png\n\n\`\`\`svg\n${svg}\n\`\`\`\n`,
      );
    }
  }

  try {
    const brandTs = gh("src/brand.ts");
    const app = gh("src/App.tsx");
    const rules = [...app.matchAll(/className="rule-note">([^<]+)</g)].map((m) => `- ${m[1].trim()}`);
    const fonts = [...app.matchAll(/\{ name: '([^']+)'[^}]*label: '([^']+)', href: [`']([^`']+)[`']/g)].map(
      ([, name, label, href]) => `- ${name} (${label}): ${href.startsWith("http") ? href : `${SITE}${href.replace("${FONT_PATH}", "/assets/fonts/")}`}`,
    );
    write(
      "brand-site.md",
      [
        "# Brand colors, palette, product colors, lockups, and fonts",
        "",
        `Source: ${SITE} (code: github.com/${REPO}, src/brand.ts). Volt is the primary accent, Void the primary ink, Canvas the primary surface.`,
        "",
        "## Rules",
        ...rules,
        "",
        "## Fonts",
        ...fonts,
        "",
        "## Brand tokens (src/brand.ts)",
        "```ts",
        brandTs.trim(),
        "```",
        "",
      ].join("\n"),
    );
  } catch (err) {
    console.warn(`  Skipped brand-site.md: couldn't read ${REPO} with gh (${(err as Error).message.split("\n")[0]}).`);
  }

  write(
    "assets.md",
    [
      "# Brand assets and where to download them",
      "",
      `Everything below is public on ${SITE}.`,
      "",
      "## Logos",
      ...LOGOS.flatMap((l) => COLORWAYS.map((w) => `- ${l.name}, ${w.suffix}: ${SITE}/assets/logos/${l.file}_${w.suffix}.svg (PNG: .png)`)),
      "",
      "## Gradients",
      ...["mesh", "secrets", "certificates", "pam"].map((g) => `- ${g}: ${SITE}/assets/gradients/gradient-${g}.png`),
      "",
      "## Social banners",
      `- LinkedIn (1584×396): ${SITE}/assets/social/linkedin-banner.png`,
      `- X / Twitter (1500×500): ${SITE}/assets/social/twitter-banner.png`,
      "",
      "## Video",
      `- Intro: ${SITE}/assets/video/intro.webm`,
      `- Outro: ${SITE}/assets/video/outro.webm`,
      "",
      "## Fonts",
      `- Alliance No.2 (OTF): ${SITE}/assets/fonts/AllianceNo2-Regular.otf`,
      "",
    ].join("\n"),
  );
  console.log("Done.");
}

main().catch((err) => {
  console.error(`sync-brand failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
