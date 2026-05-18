/**
 * pi-extension-smart-edit
 *
 * Overrides the built-in `edit` tool with a smarter version that tolerates
 * quote and whitespace mismatches. Ideal for local LLMs that can struggle
 * to reproduce exact formatting.
 *
 * Matching strategy is implemented in `smart-match.ts`:
 * 1. Exact match (fast path)
 * 2. Normalized line match (quote/whitespace tolerant)
 *
 * Replacements are applied to the original content (not normalized text),
 * preserving file formatting outside the edited ranges.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { smartEditMany, type SmartEditBlock } from "./smart-match.ts";

// Replicate the edit-diff utilities we need (they're not all exported)
function detectLineEnding(content: string): string {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: string): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

/** Simple unified diff for the tool result */
function simpleDiff(oldContent: string, newContent: string): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const output: string[] = [];

  // Find first different line
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }

  // Find last different line
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldLines[oldEnd] === newLines[newEnd]
  ) {
    oldEnd--;
    newEnd--;
  }

  // Context before
  const contextStart = Math.max(0, start - 3);
  for (let i = contextStart; i < start; i++) {
    output.push(` ${i + 1} ${oldLines[i]}`);
  }

  // Removed lines
  for (let i = start; i <= oldEnd; i++) {
    output.push(`-${i + 1} ${oldLines[i]}`);
  }

  // Added lines
  for (let i = start; i <= newEnd; i++) {
    output.push(`+${i + 1} ${newLines[i]}`);
  }

  // Context after
  const contextEnd = Math.min(oldLines.length - 1, oldEnd + 3);
  for (let i = oldEnd + 1; i <= contextEnd; i++) {
    output.push(` ${i + 1} ${oldLines[i]}`);
  }

  return output.join("\n");
}

const editSchema = Type.Object({
  path: Type.String({
    description: "Path to the file to edit (relative or absolute)",
  }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({
        description: "Exact text for one targeted replacement",
      }),
      newText: Type.String({ description: "Replacement text for this edit" }),
    }),
    { description: "One or more targeted replacements" },
  ),
});

export function prepareEditArguments(args: unknown): {
  path: string;
  edits: SmartEditBlock[];
} {
  if (!args || typeof args !== "object")
    return args as { path: string; edits: SmartEditBlock[] };

  const input = args as {
    path?: string;
    edits?: SmartEditBlock[];
    oldText?: unknown;
    newText?: unknown;
  };

  if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
    return args as { path: string; edits: SmartEditBlock[] };
  }

  return {
    ...input,
    edits: [
      ...(input.edits ?? []),
      { oldText: input.oldText, newText: input.newText },
    ],
  } as { path: string; edits: SmartEditBlock[] };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "Smart Edit",
    description:
      "Edit a single file with smart matching. Supports one or more targeted replacements in edits[]. Prefer batching disjoint replacements into one call.",
    promptSnippet:
      "Make precise file edits with smart matching (whitespace/quote tolerant). For multiple disjoint changes in one file, use one call with edits[].",
    promptGuidelines: [
      "Use this tool for precise text replacements in one file.",
      "When changing multiple locations in the same file, send ONE edit call with multiple entries in edits[].",
      'Example payload: {"path":"src/file.ts","edits":[{"oldText":"const a = 1;","newText":"const a = 2;"},{"oldText":"return x;","newText":"return y;"}]}',
      "Each edits[].oldText must be unique; include 1-2 surrounding lines if needed to disambiguate.",
      "Keep edits[].oldText as small as possible while still unique.",
    ],
    parameters: editSchema,
    prepareArguments: prepareEditArguments,

    async execute(_toolCallId, { path, edits }, signal, _onUpdate, ctx) {
      const cleanPath = path.startsWith("@") ? path.slice(1) : path;
      const absolutePath = resolve(ctx.cwd, cleanPath);

      return withFileMutationQueue(absolutePath, async () => {
        if (signal?.aborted) throw new Error("Operation aborted");

        // Check file exists
        try {
          await access(absolutePath, constants.R_OK | constants.W_OK);
        } catch {
          throw new Error(`File not found: ${path}`);
        }

        if (signal?.aborted) throw new Error("Operation aborted");

        // Read file
        const buffer = await readFile(absolutePath);
        const rawContent = buffer.toString("utf-8");

        const { bom, text: content } = stripBom(rawContent);
        const originalEnding = detectLineEnding(content);
        const normalizedContent = normalizeToLF(content);
        const normalizedEdits = edits.map((edit) => ({
          oldText: normalizeToLF(edit.oldText),
          newText: normalizeToLF(edit.newText),
        }));
        if (signal?.aborted) throw new Error("Operation aborted");

        // Smart edit: exact -> quote/whitespace-normalized (line-based)
        const result = smartEditMany(normalizedContent, normalizedEdits);

        if (signal?.aborted) throw new Error("Operation aborted");

        // Write result
        const finalContent =
          bom + restoreLineEndings(result.newContent, originalEnding);
        await writeFile(absolutePath, finalContent, "utf-8");

        // Generate diff for display
        const diff = simpleDiff(normalizedContent, result.newContent);
        const firstChangedLine = diff
          .split("\n")
          .find((l) => l.startsWith("+"))
          ?.match(/^\+(\d+)/)?.[1];

        const allExact = result.matchTypes.every((m) => m === "exact");
        const matchInfo = allExact
          ? ""
          : ` (matched via ${Array.from(new Set(result.matchTypes)).join(", ")})`;

        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully replaced ${normalizedEdits.length} block(s) in ${path}.${matchInfo}`,
            },
          ],
          details: {
            diff,
            firstChangedLine: firstChangedLine
              ? parseInt(firstChangedLine)
              : undefined,
          },
        };
      });
    },
  });

}
