import type { ActivationReason } from "./engine.js";
import { POSITION } from "./lorebook.js";

/**
 * Turns activated entries into the three slots the prompt builder understands.
 *
 * SillyTavern sorts activated entries by `order` descending and then unshifts
 * each into its bucket, which leaves the joined text in ascending `order`.
 * Entries are joined with a single newline, matching ST.
 */

export interface DepthGroup {
  depth: number;
  /** 0 system, 1 user, 2 assistant. */
  role: number;
  content: string;
  entries: string[];
}

export interface PlacedLore {
  before: string;
  after: string;
  depths: DepthGroup[];
  /** Entries whose position has no slot here yet. */
  unsupported: { title: string; position: number }[];
}

const DEFAULT_DEPTH = 4;
const SYSTEM_ROLE = 0;

export function placeEntries(activated: ActivationReason[]): PlacedLore {
  const before: string[] = [];
  const after: string[] = [];
  const depths: DepthGroup[] = [];
  const unsupported: { title: string; position: number }[] = [];

  const sorted = [...activated].sort((a, b) => b.entry.order - a.entry.order);

  for (const { entry } of sorted) {
    const content = entry.content.trim();
    if (!content) continue;

    switch (entry.position) {
      case POSITION.before:
        before.unshift(content);
        break;
      case POSITION.after:
        after.unshift(content);
        break;
      case POSITION.atDepth: {
        const depth = entry.depth ?? DEFAULT_DEPTH;
        const role = entry.role ?? SYSTEM_ROLE;
        const group = depths.find((g) => g.depth === depth && g.role === role);
        if (group) group.entries.unshift(content);
        else depths.push({ depth, role, content: "", entries: [content] });
        break;
      }
      default:
        // Author's note and example-message anchors have no slot here yet.
        unsupported.push({ title: entry.comment, position: entry.position });
    }
  }

  for (const group of depths) group.content = group.entries.join("\n");

  return {
    before: before.join("\n"),
    after: after.join("\n"),
    depths,
    unsupported,
  };
}
