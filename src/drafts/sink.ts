// Where draft tools read and write drafts. Locally that's the file store; in a
// sandbox it's memory, and the host re-checks and saves what comes back.
import { getDraft, saveDraft } from "./store.js";
import type { Draft } from "./types.js";

export interface DraftSink {
  get(id: string): Draft | undefined;
  save(draft: Draft): void;
}

export const storeSink: DraftSink = { get: getDraft, save: saveDraft };

export function memorySink(seed?: Draft): DraftSink & { saved(): Draft[] } {
  const drafts = new Map<string, Draft>();
  const saved = new Set<string>();
  const copy = (d: Draft): Draft => structuredClone(d);
  if (seed) drafts.set(seed.id, copy(seed));
  return {
    get: (id) => {
      const d = drafts.get(id);
      return d && copy(d);
    },
    save: (d) => {
      drafts.set(d.id, copy(d));
      saved.add(d.id);
    },
    saved: () => [...saved].map((id) => copy(drafts.get(id)!)),
  };
}
