/**
 * Project sanity checks: entrypoints, CI config, and invariants from PROGRESS.md.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("Project sanity", () => {
  it("src/index.ts does not exist (local-only runtime)", () => {
    const p = path.join(process.cwd(), "src", "index.ts");
    expect(fs.existsSync(p)).toBe(false);
  });

  it("src/local-server.ts exists as main entry", () => {
    const p = path.join(process.cwd(), "src", "local-server.ts");
    expect(fs.existsSync(p)).toBe(true);
  });

  it(".github/workflows/test.yml includes master in branches", () => {
    const p = path.join(process.cwd(), ".github", "workflows", "test.yml");
    const content = fs.readFileSync(p, "utf-8");
    expect(content).toContain("master");
  });
});
