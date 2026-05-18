import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { prepareEditArguments } from "./index.ts";

describe("prepareEditArguments", () => {
  it("keeps modern edits[] input unchanged", () => {
    const input = {
      path: "file.ts",
      edits: [{ oldText: "a", newText: "b" }],
    };

    assert.deepEqual(prepareEditArguments(input), input);
  });

  it("converts legacy oldText/newText input to edits[]", () => {
    const input = {
      path: "file.ts",
      oldText: "a",
      newText: "b",
    };

    assert.deepEqual(prepareEditArguments(input), {
      path: "file.ts",
      edits: [{ oldText: "a", newText: "b" }],
      oldText: "a",
      newText: "b",
    });
  });
});
