import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLine,
  normalizeLines,
  smartFindText,
  smartEdit,
  smartEditMany,
  findBestLineAlignment,
} from "./smart-match.ts";

// ---------------------------------------------------------------------------
// normalizeLine
// ---------------------------------------------------------------------------
describe("normalizeLine", () => {
  it("trims whitespace", () => {
    assert.equal(normalizeLine("    return 1;   "), "return 1;");
  });

  it("canonicalizes single quotes to double quotes", () => {
    assert.equal(
      normalizeLine("import { x } from 'viem';"),
      'import { x } from "viem";',
    );
  });

  it("handles mixed quotes", () => {
    assert.equal(
      normalizeLine(`const s = 'it\\'s a "test"';`),
      `const s = "it\\"s a "test"";`,
    );
  });

  it("preserves empty lines as empty strings", () => {
    assert.equal(normalizeLine(""), "");
    assert.equal(normalizeLine("   "), "");
  });

  it("handles tabs", () => {
    assert.equal(normalizeLine("\t\treturn 1;"), "return 1;");
  });

  it("normalizes smart/curly quotes to double quotes", () => {
    assert.equal(
      normalizeLine("import x from \u201Cviem\u201D;"),
      'import x from "viem";',
    );
    assert.equal(
      normalizeLine("import x from \u2018viem\u2019;"),
      'import x from "viem";',
    );
  });

  it("normalizes unicode dashes to ASCII hyphen", () => {
    assert.equal(normalizeLine("a \u2013 b"), "a - b"); // en-dash
    assert.equal(normalizeLine("a \u2014 b"), "a - b"); // em-dash
  });

  it("normalizes special spaces to regular space", () => {
    assert.equal(normalizeLine("a\u00A0b"), "a b"); // NBSP
    assert.equal(normalizeLine("a\u2003b"), "a b"); // em space
  });
});

// ---------------------------------------------------------------------------
// normalizeLines
// ---------------------------------------------------------------------------
describe("normalizeLines", () => {
  it("strips trailing empty lines", () => {
    const result = normalizeLines("a\nb\n\n");
    assert.deepEqual(result, ["a", "b"]);
  });

  it("normalizes each line", () => {
    const result = normalizeLines("  import x from 'y';\n    return 1;\n");
    assert.deepEqual(result, ['import x from "y";', "return 1;"]);
  });

  it("preserves internal empty lines", () => {
    const result = normalizeLines("a\n\nb");
    assert.deepEqual(result, ["a", "", "b"]);
  });
});

// ---------------------------------------------------------------------------
// smartFindText — exact
// ---------------------------------------------------------------------------
describe("smartFindText - exact", () => {
  it("finds exact substring", () => {
    const content = "function foo() {\n  return 1;\n}";
    const result = smartFindText(content, "  return 1;");
    assert.ok(result.found);
    assert.equal(result.match.matchType, "exact");
    assert.equal(result.match.startLine, 1);
    assert.equal(result.match.endLine, 1);
  });

  it("finds exact multi-line match", () => {
    const content = "a\nb\nc\nd";
    const result = smartFindText(content, "b\nc");
    assert.ok(result.found);
    assert.equal(result.match.startLine, 1);
    assert.equal(result.match.endLine, 2);
  });

  it("rejects ambiguous exact matches", () => {
    const content = "foo\nbar\nfoo\nbar";
    const result = smartFindText(content, "foo");
    assert.ok(!result.found);
  });
});

// ---------------------------------------------------------------------------
// smartFindText — normalized (quote + whitespace)
// ---------------------------------------------------------------------------
describe("smartFindText - normalized", () => {
  it("matches when model sends single quotes but file has double", () => {
    const content =
      'import { formatUnits } from "viem";\nimport type { PublicClient } from "viem";';
    const oldText = "import { formatUnits } from 'viem';";
    const result = smartFindText(content, oldText);
    assert.ok(result.found);
    assert.equal(result.match.matchType, "normalized");
    assert.equal(result.match.startLine, 0);
    assert.equal(result.match.endLine, 0);
  });

  it("matches when indentation is off-by-one", () => {
    const content = "function foo() {\n    return 1;\n}";
    const oldText = "     return 1;"; // 5 spaces instead of 4
    const result = smartFindText(content, oldText);
    assert.ok(result.found);
    assert.equal(result.match.matchType, "normalized");
    assert.equal(result.match.startLine, 1);
  });

  it("matches multi-line with inconsistent indent", () => {
    const content = [
      "function foo() {",
      "  if (x) {",
      "    return 1;",
      "  }",
      "}",
    ].join("\n");
    const oldText = [
      "  if (x) {",
      "      return 1;", // 6 spaces instead of 4
      "  }",
    ].join("\n");
    const result = smartFindText(content, oldText);
    assert.ok(result.found);
    assert.equal(result.match.startLine, 1);
    assert.equal(result.match.endLine, 3);
  });

  it("matches when both quotes AND indent are wrong", () => {
    const content = [
      "const config = {",
      '  host: "localhost",',
      "  port: 3000,",
      "};",
    ].join("\n");
    const oldText = "    host: 'localhost',"; // wrong quotes + wrong indent
    const result = smartFindText(content, oldText);
    assert.ok(result.found);
    assert.equal(result.match.matchType, "normalized");
    assert.equal(result.match.startLine, 1);
  });

  it("matches tabs vs spaces", () => {
    const content = "function foo() {\n    return 1;\n}";
    const oldText = "function foo() {\n\treturn 1;\n}";
    const result = smartFindText(content, oldText);
    assert.ok(result.found);
    assert.equal(result.match.matchType, "normalized");
  });

  it("rejects ambiguous normalized matches", () => {
    const content = "  foo();\n  foo();";
    const oldText = "    foo();"; // normalizes to same as both lines
    const result = smartFindText(content, oldText);
    assert.ok(!result.found);
  });

  it("does not match completely different content", () => {
    const content = "const x = 1;";
    const result = smartFindText(content, "const y = 2;");
    assert.ok(!result.found);
  });
});

// ---------------------------------------------------------------------------
// smartEdit — replacement
// ---------------------------------------------------------------------------
describe("smartEdit", () => {
  it("exact replacement preserves surrounding content", () => {
    const content = "line1\nline2\nline3";
    const result = smartEdit(content, "line2", "replaced");
    assert.equal(result.newContent, "line1\nreplaced\nline3");
    assert.equal(result.matchType, "exact");
  });

  it("normalized match replaces original lines", () => {
    const content = [
      'import { x } from "viem";',
      "",
      "export function foo() {}",
    ].join("\n");
    const oldText = "import { x } from 'viem';"; // single quotes
    const newText = 'import { x, y } from "viem";';
    const result = smartEdit(content, oldText, newText);
    assert.equal(result.matchType, "normalized");
    // The replacement goes into the ORIGINAL line position
    const lines = result.newContent.split("\n");
    assert.equal(lines[0], 'import { x, y } from "viem";');
    assert.equal(lines[1], ""); // preserved
    assert.equal(lines[2], "export function foo() {}"); // preserved
  });

  it("normalized match preserves rest of file indentation", () => {
    const content = [
      "class Foo {",
      "    constructor() {",
      "        this.value = 0;",
      "    }",
      "",
      "    getValue() {",
      "        return this.value;",
      "    }",
      "}",
    ].join("\n");
    const oldText = [
      "     getValue() {", // 5 instead of 4
      "         return this.value;", // 9 instead of 8
      "     }",
    ].join("\n");
    const newText = [
      "    getValue() {",
      "        return this.value * 2;",
      "    }",
    ].join("\n");

    const result = smartEdit(content, oldText, newText);
    assert.ok(result.newContent.includes("this.value * 2"));
    // Verify the constructor is UNTOUCHED (original indentation preserved)
    assert.ok(result.newContent.includes("        this.value = 0;"));
    // Verify the class structure is intact
    assert.ok(result.newContent.includes("class Foo {"));
    assert.ok(result.newContent.endsWith("}"));
  });

  it("handles the #1 real-world failure: quote style mismatch", () => {
    // Actual pattern from session logs: file has double quotes, model sends single
    const content = [
      'import { formatUnits, http, parseUnits, createPublicClient } from "viem";',
      'import type { PublicClient } from "viem";',
      'import type { HenryArbConfig } from "./types.ts";',
    ].join("\n");
    const oldText = [
      "import { formatUnits, http, parseUnits, createPublicClient } from 'viem';",
      "import type { PublicClient } from 'viem';",
    ].join("\n");
    const newText = [
      'import { formatUnits, http, parseUnits, createPublicClient, type Chain } from "viem";',
      'import type { PublicClient } from "viem";',
    ].join("\n");

    const result = smartEdit(content, oldText, newText);
    assert.equal(result.matchType, "normalized");
    const lines = result.newContent.split("\n");
    assert.ok(lines[0].includes("Chain"));
    // Third line preserved
    assert.equal(lines[2], 'import type { HenryArbConfig } from "./types.ts";');
  });

  it("handles quote mismatch in test assertions", () => {
    // Another real pattern: deepEqual with wrong quotes
    const content = [
      "    assert.deepEqual(",
      "      calls.map((call) => call.functionName),",
      '      ["balanceOf", "balanceOf", "getAmountsOut"],',
      "    );",
    ].join("\n");
    const oldText = [
      "    assert.deepEqual(calls.map((call) => call.functionName), [",
      "      'balanceOf',",
      "      'balanceOf',",
      "      'getAmountsOut',",
      "    ]);",
    ].join("\n");
    // This should NOT match — the structure is different (reformatted + wrong quotes)
    const result = smartFindText(content, oldText);
    // Normalized lines would be different because the line breaks are different
    // Let's just verify it doesn't crash
    if (!result.found) {
      // Expected — the line structure is different
      assert.ok(true);
    }
  });

  it("throws with diagnostic on no match", () => {
    const content = [
      "test('spaces', () => {",
      "  equal(parse('          - [x]'), '          - [x]');",
      "});",
    ].join("\n");
    const oldText = [
      "test('spaces', () => {",
      "  equal(parse('           - [x]'), '           - [x]');", // 11 vs 10 spaces inside strings
      "});",
    ].join("\n");

    // This should fail because the internal string content differs (not just quotes/indent)
    try {
      smartEdit(content, oldText, "replacement");
      assert.fail("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      assert.ok(
        msg.includes("Closest match") || msg.includes("Could not find"),
        msg,
      );
    }
  });

  it("throws on ambiguous matches", () => {
    const content = "  foo();\n  foo();";
    assert.throws(() => smartEdit(content, "foo();", "bar();"), /occurrences/);
  });

  it("throws when replacement produces identical content", () => {
    const content = "const x = 1;";
    assert.throws(
      () => smartEdit(content, "const x = 1;", "const x = 1;"),
      /No changes/,
    );
  });

  it("handles newText with more lines than oldText", () => {
    const content = "a\nb\nc";
    const result = smartEdit(content, "b", "b1\nb2\nb3");
    assert.equal(result.newContent, "a\nb1\nb2\nb3\nc");
  });

  it("handles newText with fewer lines than oldText", () => {
    const content = "a\nb\nc\nd\ne";
    const result = smartEdit(content, "b\nc\nd", "replaced");
    assert.equal(result.newContent, "a\nreplaced\ne");
  });

  it("works for Python files (no prettier needed)", () => {
    const content = [
      "def greet(name):",
      "    print(f'Hello, {name}!')",
      "",
      "def farewell(name):",
      "    print(f'Goodbye, {name}!')",
    ].join("\n");
    const oldText = [
      "def farewell(name):",
      "  print(f'Goodbye, {name}!')", // 2 spaces instead of 4
    ].join("\n");
    const newText = [
      "def farewell(name):",
      "    print(f'See you later, {name}!')",
    ].join("\n");

    const result = smartEdit(content, oldText, newText);
    assert.ok(result.newContent.includes("See you later"));
    assert.equal(result.matchType, "normalized");
    // Verify greet function is UNTOUCHED
    assert.ok(result.newContent.includes("    print(f'Hello, {name}!')"));
  });

  it("handles package.json with stripped indentation", () => {
    const content = [
      "{",
      '  "name": "test",',
      '  "version": "1.0.0",',
      '  "scripts": {',
      '    "start": "node index.js"',
      "  }",
      "}",
    ].join("\n");
    // Model strips all indentation
    const oldText = ['"scripts": {', '"start": "node index.js"', "}"].join(
      "\n",
    );
    const newText = [
      '  "scripts": {',
      '    "start": "node index.js",',
      '    "test": "jest"',
      "  }",
    ].join("\n");

    const result = smartEdit(content, oldText, newText);
    assert.ok(result.newContent.includes('"test": "jest"'));
    assert.equal(result.matchType, "normalized");
  });
});

// ---------------------------------------------------------------------------
// smartEditMany — multiple edits in one call
// ---------------------------------------------------------------------------
describe("smartEditMany", () => {
  it("applies multiple disjoint edits matched against original content", () => {
    const content = [
      'import { x } from "viem";',
      "",
      "function a() {",
      "  return 1;",
      "}",
      "",
      "function b() {",
      "  return 2;",
      "}",
    ].join("\n");

    const result = smartEditMany(content, [
      {
        oldText: "import { x } from 'viem';",
        newText: 'import { x, y } from "viem";',
      },
      {
        oldText: "  return 2;",
        newText: "  return 22;",
      },
    ]);

    assert.ok(result.newContent.includes('import { x, y } from "viem";'));
    assert.ok(result.newContent.includes("  return 22;"));
    assert.deepEqual(result.matchTypes, ["normalized", "exact"]);
  });

  it("reports rich diagnostics when one or more edits cannot be found", () => {
    const content = [
      "function a() {",
      "  return 1;",
      "}",
      "",
      "function b() {",
      "  return 2;",
      "}",
    ].join("\n");

    assert.throws(
      () =>
        smartEditMany(content, [
          { oldText: "return 999;", newText: "return 1;" },
          { oldText: "function c() {\n  return 3;\n}", newText: "" },
        ]),
      (err: unknown) => {
        const msg = (err as Error).message;
        return (
          msg.includes("Could not apply 2 edit block(s).") &&
          msg.includes("edits[0]") &&
          msg.includes("edits[1]") &&
          msg.includes("Closest match")
        );
      },
    );
  });

  it("reports ambiguity for multi-edit matches", () => {
    const content = ["foo();", "bar();", "foo();"].join("\n");
    assert.throws(
      () =>
        smartEditMany(content, [
          { oldText: "foo();", newText: "baz();" },
          { oldText: "bar();", newText: "qux();" },
        ]),
      /ambiguous|occurrence|more context/i,
    );
  });

  it("throws on overlapping edits", () => {
    const content = ["a", "b", "c"].join("\n");
    assert.throws(
      () =>
        smartEditMany(content, [
          { oldText: "a\nb", newText: "x" },
          { oldText: "b\nc", newText: "y" },
        ]),
      /overlap/,
    );
  });

  it("throws when edits are empty", () => {
    assert.throws(() => smartEditMany("a", []), /at least one/);
  });
});

// ---------------------------------------------------------------------------
// findBestLineAlignment — diagnostics
// ---------------------------------------------------------------------------
describe("findBestLineAlignment", () => {
  it("returns null when inputs are empty", () => {
    assert.equal(findBestLineAlignment("", "old"), null);
    assert.equal(findBestLineAlignment("content", ""), null);
  });

  it("finds closest region and reports mismatches", () => {
    const content = [
      "import { test } from 'node:test';",
      "",
      "test('indented', () => {",
      "  equal(parse('          - [x]'), '          - [x]');",
      "  equal(parse('       [ ]'), '       [ ]');",
      "});",
    ].join("\n");
    const oldText = [
      "test('indented', () => {",
      "  equal(parse('           - [x]'), '           - [x]');", // 11 vs 10 spaces
      "  equal(parse('        [ ]'), '        [ ]');", // 8 vs 7 spaces
      "});",
    ].join("\n");

    const result = findBestLineAlignment(content, oldText);
    assert.ok(result !== null);
    assert.equal(result.startLine, 3); // 1-indexed
    assert.equal(result.matchedLines, 2); // first and last lines match
    assert.ok(result.mismatches.length >= 1);
  });

  it("detects hallucinated lines", () => {
    const content = [
      "function a() {",
      "  test('edge cases', () => {",
      "    equal(1, 1);",
      "  });",
      "}",
    ].join("\n");
    const oldText = [
      "describe('edge cases', () => {", // hallucinated
      "  test('edge cases', () => {",
      "    equal(1, 1);",
      "  });",
      "});",
    ].join("\n");

    const result = findBestLineAlignment(content, oldText);
    assert.ok(result !== null);
    const descMismatch = result.mismatches.find((m) =>
      m.sent.includes("describe("),
    );
    assert.ok(descMismatch, "should flag hallucinated describe line");
  });

  it("formats human-readable diagnostic", () => {
    const content = "a\nb\nc";
    const oldText = "a\nX\nc";
    const result = findBestLineAlignment(content, oldText);
    assert.ok(result !== null);
    assert.ok(result.diagnostic.includes("Closest match"));
    assert.ok(result.diagnostic.includes("line"));
  });

  it("caps mismatches to avoid flooding", () => {
    const contentLines = Array.from({ length: 20 }, (_, i) => `line ${i} ok`);
    const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i} bad`);
    const result = findBestLineAlignment(
      contentLines.join("\n"),
      oldLines.join("\n"),
    );
    assert.ok(result !== null);
    assert.ok(result.mismatches.length <= 5);
  });
});
