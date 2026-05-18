/**
 * Integration tests: exercise smartEdit against real files on disk.
 * These test the full flow without needing pi or an LLM.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { smartEdit } from "./smart-match.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "smart-edit-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("integration: smartEdit on real files", () => {
  it("exact match on TypeScript file", async () => {
    const filepath = join(tempDir, "test.ts");
    const content = [
      "export class Greeter {",
      "  greet(name: string): string {",
      '    return `Hello, ${name}!`;',
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(filepath, content);

    const result = smartEdit(
      content,
      '    return `Hello, ${name}!`;',
      '    return `Hi, ${name}!`;'
    );

    assert.ok(result.newContent.includes("Hi,"));
    assert.ok(!result.newContent.includes("Hello,"));
    assert.equal(result.matchType, "exact");
  });

  it("whitespace-tolerant match: 5 spaces instead of 4", async () => {
    const filepath = join(tempDir, "test.ts");
    const content = [
      "function process(items: string[]) {",
      "    for (const item of items) {",
      "        console.log(item);",
      "    }",
      "}",
      "",
    ].join("\n");
    await writeFile(filepath, content);

    const oldText = [
      "     for (const item of items) {",
      "         console.log(item);",
      "     }",
    ].join("\n");
    const newText = [
      "    for (const item of items) {",
      "        console.log(item.toUpperCase());",
      "    }",
    ].join("\n");

    const result = smartEdit(content, oldText, newText);

    assert.ok(result.newContent.includes("toUpperCase"));
    assert.equal(result.matchType, "normalized");
    // Original surrounding lines preserved
    assert.ok(result.newContent.includes("function process(items: string[]) {"));
  });

  it("quote-style mismatch (the #1 real failure)", async () => {
    const filepath = join(tempDir, "test.ts");
    const content = [
      'import { formatUnits, http, parseUnits, createPublicClient } from "viem";',
      'import type { PublicClient } from "viem";',
      'import type { HenryArbConfig } from "./types.ts";',
      "",
      "export function createChainClient(config: HenryArbConfig): PublicClient {",
      "  return createPublicClient({ transport: http(config.rpcUrl) });",
      "}",
      "",
    ].join("\n");
    await writeFile(filepath, content);

    // Model sends single quotes
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
    assert.ok(result.newContent.includes("Chain"));
    // Rest of file untouched
    assert.ok(result.newContent.includes('import type { HenryArbConfig } from "./types.ts";'));
    assert.ok(result.newContent.includes("createChainClient"));
  });

  it("handles CSS files", async () => {
    const filepath = join(tempDir, "style.css");
    const content = [
      ".container {",
      "  display: flex;",
      "  justify-content: center;",
      "  align-items: center;",
      "}",
      "",
    ].join("\n");
    await writeFile(filepath, content);

    const oldText = "    justify-content: center;"; // wrong indent
    const newText = "  justify-content: space-between;";

    const result = smartEdit(content, oldText, newText);
    assert.ok(result.newContent.includes("space-between"));
  });

  it("handles JSON files with stripped indentation", async () => {
    const filepath = join(tempDir, "config.json");
    const content = JSON.stringify({ name: "test", version: "1.0.0" }, null, 2) + "\n";
    await writeFile(filepath, content);

    const result = smartEdit(
      content,
      '"version": "1.0.0"',
      '"version": "2.0.0"'
    );
    assert.ok(result.newContent.includes('"version": "2.0.0"'));
  });

  it("preserves file when match fails", async () => {
    const filepath = join(tempDir, "test.ts");
    const content = "const x = 1;\n";
    await writeFile(filepath, content);

    assert.throws(
      () => smartEdit(content, "const y = 2;", "const z = 3;"),
      /Could not find/
    );
  });

  it("rejects ambiguous matches", async () => {
    const filepath = join(tempDir, "test.ts");
    const content = [
      "function a() {",
      "  return 1;",
      "}",
      "function b() {",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    await writeFile(filepath, content);

    assert.throws(
      () => smartEdit(content, "  return 1;", "  return 2;"),
      /occurrences/
    );
  });

  it("handles Python files (whitespace match)", async () => {
    const filepath = join(tempDir, "script.py");
    const content = [
      "def greet(name):",
      "    print(f'Hello, {name}!')",
      "",
      "def farewell(name):",
      "    print(f'Goodbye, {name}!')",
      "",
    ].join("\n");
    await writeFile(filepath, content);

    const oldText = [
      "def farewell(name):",
      "  print(f'Goodbye, {name}!')", // 2-space instead of 4
    ].join("\n");
    const newText = [
      "def farewell(name):",
      "    print(f'See you later, {name}!')",
    ].join("\n");

    const result = smartEdit(content, oldText, newText);
    assert.ok(result.newContent.includes("See you later"));
    assert.equal(result.matchType, "normalized");
    // greet function UNTOUCHED
    assert.ok(result.newContent.includes("    print(f'Hello, {name}!')"));
  });

  it("handles large multi-function edit", async () => {
    const filepath = join(tempDir, "app.ts");
    const content = [
      "export class UserService {",
      "  private users: Map<string, User> = new Map();",
      "",
      "  addUser(user: User): void {",
      "    this.users.set(user.id, user);",
      "  }",
      "",
      "  getUser(id: string): User | undefined {",
      "    return this.users.get(id);",
      "  }",
      "",
      "  deleteUser(id: string): boolean {",
      "    return this.users.delete(id);",
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(filepath, content);

    // Model has wrong indentation (3 spaces instead of 2)
    const oldText = [
      "   getUser(id: string): User | undefined {",
      "      return this.users.get(id);",
      "   }",
    ].join("\n");
    const newText = [
      "  getUser(id: string): User | undefined {",
      "    const user = this.users.get(id);",
      '    if (!user) throw new Error(`User ${id} not found`);',
      "    return user;",
      "  }",
    ].join("\n");

    const result = smartEdit(content, oldText, newText);
    assert.ok(result.newContent.includes("throw new Error"));
    // addUser and deleteUser UNTOUCHED
    assert.ok(result.newContent.includes("    this.users.set(user.id, user);"));
    assert.ok(result.newContent.includes("    return this.users.delete(id);"));
  });
});
