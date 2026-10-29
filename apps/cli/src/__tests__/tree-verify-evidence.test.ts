import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyTreeRoot } from "../commands/tree/verify.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ft-tree-evidence-"));
  tempDirs.push(dir);
  return dir;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function node(title: string): string {
  return `---\ntitle: ${title}\nowners: [alice]\n---\n# ${title}\n`;
}

function makeTree(): string {
  const root = makeTempDir();
  write(join(root, "NODE.md"), node("Root"));
  write(join(root, "members", "NODE.md"), node("Members"));
  write(
    join(root, "members", "alice", "NODE.md"),
    "---\ntitle: Alice\nowners: [alice]\ntype: human\nrole: Engineer\ndomains: [system]\n---\n# Alice\n",
  );
  write(join(root, "system", "NODE.md"), node("System"));
  write(join(root, "system", "leaf.md"), node("Leaf"));
  return root;
}

function writeEvidence(root: string, records: unknown[], file = "system/leaf.jsonl"): void {
  write(join(root, "raw-context", "evidence", file), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "system/leaf/default",
    node: "system/leaf.md",
    kind: "default",
    claim: "The default is one.",
    sources: [{ repo: "repo", path: "src/a.ts", line: 2, quote: "const value = 1;" }],
    validAt: new Date().toISOString().slice(0, 10),
    confidence: "verified",
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("tree verify --evidence", () => {
  it("leaves trees without evidence unchanged", () => {
    const root = makeTree();
    const summary = verifyTreeRoot(root);
    expect(summary.ok).toBe(true);
    expect(summary.checks.evidence).toBeUndefined();
  });

  it("accepts a verified record when source anchors match", () => {
    const root = makeTree();
    const sourceRoot = makeTempDir();
    write(join(sourceRoot, "repo", "src", "a.ts"), "const a = 0;\nconst value = 1;\n");
    writeEvidence(root, [validRecord()]);

    const summary = verifyTreeRoot(root, { evidence: true, sourceRoot });
    expect(summary.checks.evidence).toEqual({ ok: true });
    expect(summary.findings).toEqual([]);
  });

  it("reports malformed JSONL", () => {
    const root = makeTree();
    write(join(root, "raw-context", "evidence", "system", "leaf.jsonl"), "{not json}\n");
    const summary = verifyTreeRoot(root, { evidence: true });
    expect(summary.ok).toBe(false);
    expect(summary.findings.some((finding) => finding.code === "TREE_EVIDENCE_PARSE")).toBe(true);
  });

  it("reports duplicate claim ids across files", () => {
    const root = makeTree();
    writeEvidence(root, [validRecord()], "system/a.jsonl");
    writeEvidence(root, [validRecord()], "system/b.jsonl");
    const summary = verifyTreeRoot(root, { evidence: true });
    expect(summary.findings.some((finding) => finding.code === "TREE_EVIDENCE_DUPLICATE_ID")).toBe(true);
  });

  it("requires an anchored source for verified records", () => {
    const root = makeTree();
    writeEvidence(root, [validRecord({ sources: [{ repo: "repo", path: "src/a.ts" }] })]);
    const summary = verifyTreeRoot(root, { evidence: true });
    expect(summary.findings.some((finding) => finding.code === "TREE_EVIDENCE_MISSING_SOURCE")).toBe(true);
  });

  it("reports stale evidence", () => {
    const root = makeTree();
    writeEvidence(root, [validRecord({ validAt: "2020-01-01" })]);
    const summary = verifyTreeRoot(root, { evidence: true });
    expect(summary.findings.some((finding) => finding.code === "TREE_EVIDENCE_STALE")).toBe(true);
  });

  it("reports unresolved contradictions", () => {
    const root = makeTree();
    writeEvidence(root, [validRecord({ id: "a", contradicts: ["b"] }), validRecord({ id: "b", contradicts: ["a"] })]);
    const summary = verifyTreeRoot(root, { evidence: true });
    expect(summary.findings.some((finding) => finding.code === "TREE_EVIDENCE_CONTRADICTION")).toBe(true);
  });

  it("reports a quote that is not on the declared line", () => {
    const root = makeTree();
    const sourceRoot = makeTempDir();
    write(join(sourceRoot, "repo", "src", "a.ts"), "const a = 0;\nconst value = 1;\n");
    writeEvidence(root, [
      validRecord({ sources: [{ repo: "repo", path: "src/a.ts", line: 1, quote: "const value = 1;" }] }),
    ]);
    const summary = verifyTreeRoot(root, { evidence: true, sourceRoot });
    expect(summary.findings.some((finding) => finding.code === "TREE_EVIDENCE_SOURCE_QUOTE")).toBe(true);
  });

  it("reports a missing evidence node", () => {
    const root = makeTree();
    writeEvidence(root, [validRecord({ node: "system/missing.md" })]);
    const summary = verifyTreeRoot(root, { evidence: true });
    expect(summary.findings.some((finding) => finding.code === "TREE_EVIDENCE_NODE_MISSING")).toBe(true);
  });

  it("resolves an unmapped repo from a single --source-root checkout", () => {
    const root = makeTree();
    const sourceRoot = makeTempDir();
    write(join(sourceRoot, "src", "a.ts"), "const a = 0;\nconst value = 1;\n");
    writeEvidence(root, [validRecord()]);

    const summary = verifyTreeRoot(root, { evidence: true, sourceRoot });

    expect(summary.checks.evidence).toEqual({ ok: true });
  });

  it("resolves an unmapped repo from a parent directory of checkouts", () => {
    const root = makeTree();
    const sourceRoot = makeTempDir();
    write(join(sourceRoot, "repo", "src", "a.ts"), "const a = 0;\nconst value = 1;\n");
    writeEvidence(root, [validRecord()]);

    const summary = verifyTreeRoot(root, { evidence: true, sourceRoot });

    expect(summary.checks.evidence).toEqual({ ok: true });
  });

  it("resolves a repo through raw-context/evidence/sources.json", () => {
    const root = makeTree();
    const sourceRoot = makeTempDir();
    write(join(sourceRoot, "src", "a.ts"), "const a = 0;\nconst value = 1;\n");
    write(
      join(root, "raw-context", "evidence", "sources.json"),
      `${JSON.stringify({ repos: { repo: sourceRoot } }, null, 2)}\n`,
    );
    writeEvidence(root, [validRecord()]);

    const summary = verifyTreeRoot(root, { evidence: true });

    expect(summary.checks.evidence).toEqual({ ok: true });
  });

  it("reports the missing source path as written in the record", () => {
    const root = makeTree();
    const sourceRoot = makeTempDir();
    writeEvidence(root, [validRecord()]);

    const summary = verifyTreeRoot(root, { evidence: true, sourceRoot });

    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        code: "TREE_EVIDENCE_SOURCE_MISSING",
        message: "source file not found: repo/src/a.ts",
      }),
    );
  });
});
