// `make skills`: builds Agent Vault skills from Infisical/infisical-gtm-os into the
// gitignored skills/ folder; `make push-skills` also publishes them with the CLI.
// The repo's .claude/skills are pointers to playbooks/, and the agent has no file or
// shell tools, so each skill here inlines its playbook and the references it cites.
// gtm-os is internal and this repo is public, so the output is never committed.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APP_ROOT } from "../src/config.js";

const REPO = "Infisical/infisical-gtm-os";
const OUT = path.join(APP_ROOT, "skills");
const MAX_SKILL_BYTES = 1_000_000;
const MIN_CLI = [0, 44, 11];

interface SkillPlan {
  name: string;
  /** Frontmatter comes from this gtm-os shim; omit for a skill made only of references. */
  shim?: string;
  description?: string;
  playbook?: string;
  references: string[];
}

const SKILLS: SkillPlan[] = [
  { name: "contentful", shim: "contentful", playbook: "playbooks/contentful.md", references: [] },
  { name: "case-study", shim: "case-study", playbook: "playbooks/case-study.md", references: ["references/voice-and-messaging.md"] },
  {
    name: "infisical-blog",
    shim: "infisical-blog",
    playbook: "playbooks/infisical-blog.md",
    references: ["references/voice-and-messaging.md", "references/blog-backlink-profile.md"],
  },
  { name: "grill", shim: "grill", playbook: "playbooks/grill.md", references: ["references/design.md"] },
  {
    name: "infisical-design",
    description:
      "Infisical's design and voice references from the GTM team: visual design rules for marketing pages and content, plus voice, messaging, and terminology. Use for questions about how Infisical content should look or sound, reviewing copy or a page design against the brand, or writing headlines and descriptions.",
    references: ["references/design.md", "references/voice-and-messaging.md"],
  },
];

const ADAPTER = `## Running this in Design Intern

You run without a shell or file access: no curl, python, scripts, or reading other files.
- Where this playbook calls the Contentful Management API with curl, use the contentful tools instead (search_entries, get_entry, get_content_type, and in a write session create_entry, update_entry, create_upload_session, upload_asset). Pass the space id you were given.
- You can't publish, unpublish, or delete. Stop at drafts, link them, and tell the person to publish in Contentful.
- Skip steps that need a script (generate_card_image.py, md_to_richtext.py, transcript pulls) and say what a human needs to run.
- Ignore the local Agent Proxy setup notes: credentials are attached for you, and you never see them.
- Docs this playbook cites are appended below when they were packaged. Anything else it points to isn't available here; say so instead of guessing.`;

function gh(file: string): string {
  return execFileSync("gh", ["api", `repos/${REPO}/contents/${file}`, "--jq", ".content"], { encoding: "utf8" })
    .split("\n")
    .map((l) => Buffer.from(l, "base64").toString("utf8"))
    .join("");
}

function headSha(): string {
  return execFileSync("gh", ["api", `repos/${REPO}/commits/HEAD`, "--jq", ".sha"], { encoding: "utf8" }).trim();
}

function frontmatter(md: string): { fields: Record<string, string>; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fields: {}, body: md };
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { fields, body: md.slice(m[0].length) };
}

/** YAML-safe single-line scalar. */
const yaml = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").trim());

function build(plan: SkillPlan, sha: string): string {
  const description = plan.description ?? frontmatter(gh(`.claude/skills/${plan.shim}/SKILL.md`)).fields.description;
  if (!description) throw new Error(`${plan.name}: no description in the gtm-os shim.`);
  const parts = [`---\nname: ${plan.name}\ndescription: ${yaml(description)}\n---`, `# ${plan.name}`, ADAPTER];
  if (plan.playbook) parts.push(`## Playbook (${plan.playbook})`, frontmatter(gh(plan.playbook)).body.trim());
  for (const ref of plan.references) parts.push(`## Appendix: ${ref}`, frontmatter(gh(ref)).body.trim());
  parts.push(`---\nPackaged from github.com/${REPO} at ${sha.slice(0, 12)} by design-intern's scripts/package-skills.ts. Edit the playbooks there, then repackage.`);
  return `${parts.join("\n\n")}\n`;
}

function cliSupportsSkills(): boolean {
  try {
    const v = execFileSync("infisical", ["--version"], { encoding: "utf8" }).match(/(\d+)\.(\d+)\.(\d+)/);
    if (!v) return false;
    const [a, b, c] = v.slice(1).map(Number);
    const [x, y, z] = MIN_CLI;
    return a > x || (a === x && (b > y || (b === y && c >= z)));
  } catch {
    return false;
  }
}

function main() {
  const push = process.argv.includes("--push");
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length).split(",");
  const plans = only ? SKILLS.filter((s) => only.includes(s.name)) : SKILLS;
  if (push && !cliSupportsSkills()) {
    throw new Error(`Pushing skills needs the Infisical CLI ${MIN_CLI.join(".")} or newer (brew upgrade infisical).`);
  }

  const sha = headSha();
  console.log(`Packaging ${plans.length} skills from ${REPO}@${sha.slice(0, 12)} into skills/`);
  for (const plan of plans) {
    const dir = path.join(OUT, plan.name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const body = build(plan, sha);
    const bytes = Buffer.byteLength(body);
    if (bytes > MAX_SKILL_BYTES) throw new Error(`${plan.name} is ${bytes} bytes; Agent Vault allows 1 MB per skill.`);
    writeFileSync(path.join(dir, "SKILL.md"), body);
    console.log(`  skills/${plan.name}/SKILL.md (${(bytes / 1024).toFixed(1)} KB)`);
    if (push) execFileSync("infisical", ["agent-vault", "skills", "push", dir], { stdio: "inherit" });
  }
  console.log(
    push
      ? "Pushed. Add them to the design-intern and design-intern-write bundles under Access Bundles > Skills (admin only)."
      : "Done. Review them, then `make push-skills` to publish to Agent Vault.",
  );
}

try {
  main();
} catch (err) {
  console.error(`package-skills failed: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
  process.exit(1);
}
