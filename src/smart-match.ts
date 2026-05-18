/**
 * Smart matching for edit operations.
 *
 * Strategy (in order):
 * 1. Exact match (fast path)
 * 2. Normalized match: canonicalize quotes (' → ") and trim whitespace per line,
 *    then find the matching line range and replace those lines in the ORIGINAL content.
 *
 * Key insight from real failure data:
 * - 84% of edit failures are quote-style mismatches (model sends ' but file has ")
 * - 5% are indentation off-by-one (5 spaces instead of 4)
 * - The rest are hallucinated content (no code fix for that)
 *
 * No prettier dependency — files are assumed to already be formatted.
 * Replacement is always done in the original content to avoid destroying formatting.
 */

export interface MatchResult {
  /** What kind of matching was used */
  matchType: "exact" | "normalized";
  /** The line range in the original content that was matched (0-indexed, inclusive) */
  startLine: number;
  endLine: number;
}

/**
 * Normalize a single line for matching purposes:
 * - Trim leading/trailing whitespace
 * - NFKC unicode normalization
 * - Canonicalize quotes: ' → " and smart quotes → " (covers both local LLM ASCII
 *   swaps and Unicode curly quotes from web-pasted content)
 * - Normalize Unicode dashes/hyphens → ASCII hyphen
 * - Normalize special Unicode spaces → regular space
 */
export function normalizeLine(line: string): string {
  return (
    line
      .trim()
      .normalize("NFKC")
      // All quote styles → "
      .replace(/'/g, '"')
      .replace(/[\u2018\u2019\u201A\u201B]/g, '"') // smart single quotes
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"') // smart double quotes
      // Various dashes → -
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      // Special spaces → regular space
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  );
}

/**
 * Normalize a full block of text into an array of normalized lines.
 * Empty trailing lines (from trailing newlines) are stripped.
 */
export function normalizeLines(text: string): string[] {
  const lines = text.split("\n").map(normalizeLine);
  // Strip trailing empty lines (artifact of trailing newline)
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Find the line range in `contentLines` (normalized) that matches `needleLines` (normalized).
 * Returns all match positions (for uniqueness checking).
 */
function findAllLineMatches(
  contentNorm: string[],
  needleNorm: string[],
): number[] {
  if (needleNorm.length === 0) return [];

  const matches: number[] = [];
  const maxStart = contentNorm.length - needleNorm.length;

  for (let start = 0; start <= maxStart; start++) {
    let matched = true;
    for (let j = 0; j < needleNorm.length; j++) {
      if (contentNorm[start + j] !== needleNorm[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      matches.push(start);
    }
  }
  return matches;
}

/**
 * Find oldText in content using progressively looser matching:
 * 1. Exact substring match
 * 2. Normalized line-by-line match (quotes + whitespace)
 *
 * On normalized match, returns the original line range so replacement
 * happens in original content (preserving formatting).
 */
export function smartFindText(
  content: string,
  oldText: string,
): { found: false } | { found: true; match: MatchResult } {
  // Strategy 1: Exact match
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    // Verify uniqueness
    const secondIndex = content.indexOf(oldText, exactIndex + oldText.length);
    if (secondIndex !== -1) {
      return { found: false }; // ambiguous — will be caught by caller
    }
    // Convert char index to line range
    const beforeMatch = content.substring(0, exactIndex);
    const startLine = beforeMatch.split("\n").length - 1;
    const matchLineCount = oldText.split("\n").length;
    return {
      found: true,
      match: {
        matchType: "exact",
        startLine,
        endLine: startLine + matchLineCount - 1,
      },
    };
  }

  // Strategy 2: Normalized line match
  const contentNorm = normalizeLines(content);
  const needleNorm = normalizeLines(oldText);

  if (needleNorm.length === 0) {
    return { found: false };
  }

  const matches = findAllLineMatches(contentNorm, needleNorm);

  if (matches.length === 1) {
    const startLine = matches[0];
    return {
      found: true,
      match: {
        matchType: "normalized",
        startLine,
        endLine: startLine + needleNorm.length - 1,
      },
    };
  }

  return { found: false };
}

// --- Diagnostics for failed matches ---

export interface LineMismatch {
  /** 1-indexed line number in the file */
  line: number;
  /** Content from the file (trimmed) */
  file: string;
  /** Content from the model's oldText (trimmed) */
  sent: string;
}

export interface AlignmentResult {
  startLine: number;
  matchedLines: number;
  totalLines: number;
  mismatches: LineMismatch[];
  diagnostic: string;
}

const MAX_REPORTED_MISMATCHES = 5;

function lineSimilarity(a: string, b: string): number {
  const at = normalizeLine(a);
  const bt = normalizeLine(b);
  if (at === bt) return 1;
  if (!at || !bt) return 0;
  let j = 0;
  let matches = 0;
  for (let i = 0; i < at.length && j < bt.length; i++) {
    if (at[i] === bt[j]) {
      matches++;
      j++;
    }
  }
  return matches / Math.max(at.length, bt.length);
}

/**
 * Find the region in content that best aligns with oldText line-by-line.
 * Used for diagnostics when matching fails entirely.
 */
export function findBestLineAlignment(
  content: string,
  oldText: string,
): AlignmentResult | null {
  if (!content || !oldText) return null;

  const contentLines = content.split("\n");
  const oldLines = normalizeLines(oldText);

  if (oldLines.length === 0 || contentLines.length === 0) return null;

  const contentNorm = contentLines.map(normalizeLine);

  let bestScore = 0;
  let bestStart = 0;

  for (let start = 0; start <= contentLines.length - 1; start++) {
    let score = 0;
    for (let j = 0; j < oldLines.length; j++) {
      const ci = start + j;
      if (ci < contentNorm.length && contentNorm[ci] === oldLines[j]) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  // No normalized line matches — try similarity-based
  if (bestScore === 0) {
    let bestSim = 0;
    for (let start = 0; start <= contentLines.length - 1; start++) {
      let sim = 0;
      let count = 0;
      for (let j = 0; j < oldLines.length; j++) {
        const ci = start + j;
        if (ci < contentLines.length) {
          sim += lineSimilarity(contentLines[ci], oldLines[j]);
          count++;
        }
      }
      const avg = count > 0 ? sim / count : 0;
      if (avg > bestSim) {
        bestSim = avg;
        bestStart = start;
      }
    }
    if (bestSim < 0.4) return null;
  }

  const mismatches: LineMismatch[] = [];
  for (let j = 0; j < oldLines.length; j++) {
    const ci = bestStart + j;
    const fileNorm = ci < contentNorm.length ? contentNorm[ci] : "";
    const oldNorm = oldLines[j];
    if (fileNorm !== oldNorm) {
      mismatches.push({
        line: ci + 1,
        file: ci < contentLines.length ? contentLines[ci].trimEnd() : "",
        sent: oldText.split("\n")[j]?.trimEnd() ?? "",
      });
    }
    if (mismatches.length >= MAX_REPORTED_MISMATCHES) break;
  }

  const totalMismatches = oldLines.length - bestScore;
  const diagnostic = formatDiagnostic(
    bestStart + 1,
    mismatches,
    bestScore,
    oldLines.length,
    totalMismatches,
  );

  return {
    startLine: bestStart + 1,
    matchedLines: bestScore,
    totalLines: oldLines.length,
    mismatches,
    diagnostic,
  };
}

function formatDiagnostic(
  startLine: number,
  mismatches: LineMismatch[],
  matchedLines: number,
  totalLines: number,
  totalMismatches: number,
): string {
  const lines: string[] = [];
  lines.push(
    `Closest match at line ${startLine} (${matchedLines}/${totalLines} lines match after quote/whitespace normalization).`,
  );
  if (mismatches.length > 0) {
    lines.push("Mismatched lines:");
    for (const m of mismatches) {
      lines.push(`  line ${m.line}:`);
      lines.push(`    file: ${m.file}`);
      lines.push(`    sent: ${m.sent}`);
    }
    if (mismatches.length < totalMismatches) {
      lines.push(`  ... and ${totalMismatches - mismatches.length} more`);
    }
  }
  return lines.join("\n");
}

// --- Main entry point ---

export interface SmartEditResult {
  newContent: string;
  matchType: "exact" | "normalized";
}

export interface SmartEditBlock {
  oldText: string;
  newText: string;
}

function countExactOccurrences(content: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (from <= content.length) {
    const index = content.indexOf(needle, from);
    if (index === -1) break;
    count++;
    from = index + Math.max(needle.length, 1);
  }
  return count;
}

function describeMultiEditFailure(
  content: string,
  edit: SmartEditBlock,
  index: number,
): string {
  const exactCount = countExactOccurrences(content, edit.oldText);
  if (exactCount > 1) {
    return (
      `edits[${index}]: Found ${exactCount} exact occurrences of oldText. ` +
      `Add 1-2 surrounding lines so the target is unique.`
    );
  }

  const contentNorm = normalizeLines(content);
  const needleNorm = normalizeLines(edit.oldText);
  const normalizedMatches = findAllLineMatches(contentNorm, needleNorm);
  if (normalizedMatches.length > 1) {
    const candidates = normalizedMatches
      .slice(0, 4)
      .map((start) => {
        const end = start + needleNorm.length - 1;
        return `${start + 1}-${end + 1}`;
      })
      .join(", ");
    return (
      `edits[${index}]: Found ${normalizedMatches.length} normalized occurrences ` +
      `(candidate line ranges: ${candidates}). Add more surrounding context to disambiguate.`
    );
  }

  const alignment = findBestLineAlignment(content, edit.oldText);
  const base =
    `edits[${index}]: Could not find oldText in file, even after quote/whitespace normalization.` +
    ` The content may be hallucinated or significantly different.`;

  if (alignment) {
    return `${base}\n${alignment.diagnostic}`;
  }

  return base;
}

/**
 * Perform the full smart edit: find the matching region in original content,
 * replace those lines with newText.
 *
 * - Exact match: standard substring replacement
 * - Normalized match: line-based replacement in original content (preserves formatting)
 */
export function smartEdit(
  content: string,
  oldText: string,
  newText: string,
): SmartEditResult {
  const result = smartFindText(content, oldText);

  if (!result.found) {
    const contentNorm = normalizeLines(content);
    const needleNorm = normalizeLines(oldText);
    const matches = findAllLineMatches(contentNorm, needleNorm);
    if (matches.length > 1) {
      throw new Error(
        `Found ${matches.length} occurrences of the text (after quote/whitespace normalization). Please provide more context to make it unique.`,
      );
    }

    // Also check exact substring ambiguity
    const firstExact = content.indexOf(oldText);
    if (firstExact !== -1) {
      const secondExact = content.indexOf(oldText, firstExact + oldText.length);
      if (secondExact !== -1) {
        throw new Error(
          `Found multiple exact occurrences of the text. Please provide more context to make it unique.`,
        );
      }
    }

    const alignment = findBestLineAlignment(content, oldText);
    const base =
      `Could not find the text in the file, even with quote/whitespace normalization. ` +
      `The content might have been hallucinated or significantly differs from the file.`;
    if (alignment) {
      throw new Error(`${base}\n\n${alignment.diagnostic}`);
    }
    throw new Error(base);
  }

  const { match } = result;
  const contentLines = content.split("\n");

  // Replace the matched line range with newText
  const before = contentLines.slice(0, match.startLine);
  const after = contentLines.slice(match.endLine + 1);
  const newLines = newText.split("\n");

  const newContent = [...before, ...newLines, ...after].join("\n");

  if (newContent === content) {
    throw new Error(
      `No changes made. The replacement produced identical content.`,
    );
  }

  return { newContent, matchType: match.matchType };
}

export function smartEditMany(
  content: string,
  edits: SmartEditBlock[],
): { newContent: string; matchTypes: Array<"exact" | "normalized"> } {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("edits must contain at least one replacement block.");
  }

  const failures: string[] = [];
  const matches: Array<{
    index: number;
    startLine: number;
    endLine: number;
    newLines: string[];
    matchType: "exact" | "normalized";
  }> = [];

  for (const [index, edit] of edits.entries()) {
    if (edit.oldText.length === 0) {
      failures.push(`edits[${index}]: oldText must not be empty.`);
      continue;
    }

    const found = smartFindText(content, edit.oldText);
    if (!found.found) {
      failures.push(describeMultiEditFailure(content, edit, index));
      continue;
    }

    matches.push({
      index,
      startLine: found.match.startLine,
      endLine: found.match.endLine,
      newLines: edit.newText.split("\n"),
      matchType: found.match.matchType,
    });
  }

  if (failures.length > 0) {
    const guidance =
      "Guidance: include enough surrounding lines to uniquely identify each edits[i].oldText. " +
      "When changing multiple locations in this file, keep using one edit call with multiple edits[] blocks.";
    throw new Error(
      `Could not apply ${failures.length} edit block(s).\n\n${failures.join("\n\n")}\n\n${guidance}`,
    );
  }

  const sorted = [...matches].sort((a, b) => a.startLine - b.startLine);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev.endLine >= curr.startLine) {
      throw new Error(
        `edits[${prev.index}] (${prev.startLine + 1}-${prev.endLine + 1}) and ` +
          `edits[${curr.index}] (${curr.startLine + 1}-${curr.endLine + 1}) overlap. ` +
          `Merge them into one edit block.`,
      );
    }
  }

  const lines = content.split("\n");
  for (const match of [...sorted].reverse()) {
    lines.splice(
      match.startLine,
      match.endLine - match.startLine + 1,
      ...match.newLines,
    );
  }

  const newContent = lines.join("\n");
  if (newContent === content) {
    throw new Error(
      "No changes made. The replacements produced identical content.",
    );
  }

  return { newContent, matchTypes: matches.map((m) => m.matchType) };
}
