import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonl, truncateText } from "./jsonl";
import { isInside } from "./paths";

describe("jsonl utilities", () => {
  it("streams valid and invalid jsonl without stopping", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-manager-"));
    const file = path.join(dir, "sample.jsonl");
    fs.writeFileSync(file, '{"a":1}\nnot-json\n{"b":2}\n', "utf8");

    const values: unknown[] = [];
    const count = await readJsonl(file, ({ value }) => values.push(value));

    expect(count).toBe(3);
    expect(values).toHaveLength(3);
    expect(values[0]).toEqual({ a: 1 });
    expect(values[1]).toMatchObject({ parse_error: true });
    expect(values[2]).toEqual({ b: 2 });
  });

  it("truncates whitespace-heavy text predictably", () => {
    expect(truncateText("  a\n\nb   c  ", 20)).toBe("a b c");
    expect(truncateText("1234567890", 6)).toBe("12345…");
  });
});

describe("path safety", () => {
  it("accepts children and rejects sibling traversal", () => {
    expect(isInside("/tmp/root", "/tmp/root/a/b.jsonl")).toBe(true);
    expect(isInside("/tmp/root", "/tmp/root")).toBe(true);
    expect(isInside("/tmp/root", "/tmp/root-evil/a.jsonl")).toBe(false);
    expect(isInside("/tmp/root", "/tmp/root/../other/a.jsonl")).toBe(false);
  });
});
