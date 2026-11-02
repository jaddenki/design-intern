import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPreviews, resolvePreviews } from "../drafts/validate.js";
import type { Draft } from "../drafts/types.js";
import type { FrameRender, SourceRef } from "../run-context.js";
import { approvedBlocks, previewBlocks } from "../slack-approval.js";
import { FIGMA_IMAGE_URL, NODE_ID, normalizeNodeId } from "./api.js";

const KEY = "AbCdEfGhIjKlMnOpQrStUv";
const URL_OK = "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/0b9c-4f1e";
const render: FrameRender = { fileKey: KEY, nodeId: "12:34", name: "Pricing / Hero", url: URL_OK };
const renders = new Map([[`${KEY}:12:34`, render]]);
const known = new Map<string, SourceRef>([[`figma:${KEY}`, { id: `figma:${KEY}`, kind: "figma", title: "f" }]]);

test("node ids: URL form normalizes, junk doesn't pass", () => {
  assert.equal(normalizeNodeId("12-34"), "12:34");
  assert.ok(NODE_ID.test("I12:34;56:78"));
  assert.ok(!NODE_ID.test("12:34/../x"));
});

test("image URLs: only Figma's render bucket", () => {
  assert.ok(FIGMA_IMAGE_URL.test(URL_OK));
  assert.ok(!FIGMA_IMAGE_URL.test("https://evil.example/x.png"));
  assert.ok(!FIGMA_IMAGE_URL.test("https://figma-alpha-api.s3.us-west-2.amazonaws.com.evil.io/x.png"));
  assert.ok(!FIGMA_IMAGE_URL.test("http://figma-alpha-api.s3.us-west-2.amazonaws.com/x.png"));
});

test("previews: only frames rendered this run (or already on the draft)", () => {
  const ok = resolvePreviews([{ fileKey: KEY, nodeId: "12-34", caption: "New hero" }], renders);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.previews, [{ ...render, caption: "New hero" }]);
  assert.equal(resolvePreviews([{ fileKey: KEY, nodeId: "9:9" }], renders).errors.length, 1);
  assert.equal(resolvePreviews([{ fileKey: KEY, nodeId: "12:34" }], new Map(), ok.previews).errors.length, 0);
  assert.equal(resolvePreviews(Array(5).fill({ fileKey: KEY, nodeId: "12:34" }), renders).errors.length, 1);
});

test("host re-check: rejects foreign URLs and files no tool returned", () => {
  assert.equal(checkPreviews(undefined, known), undefined);
  assert.equal(checkPreviews([render], known)?.length, 1);
  assert.throws(() => checkPreviews([{ ...render, url: "https://evil.example/x.png" }], known));
  assert.throws(() => checkPreviews([render], new Map()));
  assert.throws(() => checkPreviews([{ ...render, nodeId: "x" }], known));
});

test("Slack preview: each frame is an image plus a link back to Figma; can be dropped", () => {
  const draft: Draft = {
    id: "d1",
    status: "pending",
    createdAt: "2026-10-30T00:00:00Z",
    updatedAt: "2026-10-30T00:00:00Z",
    createdBy: "t",
    window: { since: "2026-10-23T00:00:00Z", until: "2026-10-30T00:00:00Z" },
    lines: [{ id: "l1", section: "shipped", text: "Shipped the hero", sourceIds: [`figma:${KEY}`] }],
    notes: [],
    sources: Object.fromEntries(known),
    history: [],
    previews: [{ ...render, caption: "New hero" }],
  };
  const blocks = previewBlocks(draft);
  const image = blocks.find((b) => b.type === "image") as { image_url: string; title?: { text: string } } | undefined;
  assert.equal(image?.image_url, URL_OK);
  assert.equal(image?.title?.text, "New hero");
  assert.ok(JSON.stringify(blocks).includes(`https://www.figma.com/design/${KEY}?node-id=12-34`));
  assert.ok(!previewBlocks(draft, { images: false }).some((b) => b.type === "image"));
});

test("approved post: the message plus its frames, long messages split into sections", () => {
  const draft = { previews: [render] } as unknown as Draft;
  const blocks = approvedBlocks(draft, Array(80).fill("x".repeat(60)).join("\n"));
  const sections = blocks.filter((b) => b.type === "section") as { text: { text: string } }[];
  assert.ok(sections.length >= 2 && sections.every((s) => s.text.text.length <= 2900));
  assert.equal(blocks.filter((b) => b.type === "image").length, 1);
  assert.ok(!approvedBlocks(draft, "hi", { images: false }).some((b) => b.type === "image"));
});
