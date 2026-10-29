import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { type TreeValidationFinding, VALIDATION_CODES } from "./validation-finding.js";

export const EVIDENCE_DIRECTORY = join("raw-context", "evidence");
export const DEFAULT_MAX_EVIDENCE_AGE_DAYS = 180;

export type EvidenceVerifyOptions = {
  maxAgeDays?: number;
  sourceRoot?: string;
};

export type EvidenceCollection = {
  count: number;
  findings: TreeValidationFinding[];
};

type EvidenceSource = {
  repo?: string;
  path: string;
  line?: number;
  quote?: string;
};

type EvidenceRecord = {
  id: string;
  node: string;
  claim: string;
  kind?: string;
  sources: EvidenceSource[];
  validAt?: string;
  confidence?: string;
  supersedes?: string[];
  contradicts?: string[];
  dependsOn?: string[];
  resolution?: string;
};

const EVIDENCE_KINDS = new Set(["decision", "constraint", "default", "branch", "failure", "metric", "contract"]);
const CONFIDENCE_LEVELS = new Set(["verified", "draft", "disputed", "superseded"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return undefined;
  }
  return value as string[];
}

function toPosixPath(path: string): string {
  return path.replace(/\\/gu, "/");
}

function walkJsonlFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsonlFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function parseEvidenceFile(
  absolutePath: string,
  relativePath: string,
): { records: EvidenceRecord[]; findings: TreeValidationFinding[] } {
  const findings: TreeValidationFinding[] = [];
  const records: EvidenceRecord[] = [];
  let text: string;
  try {
    text = readFileSync(absolutePath, "utf-8");
  } catch (error) {
    findings.push({
      code: VALIDATION_CODES.evidenceParse,
      message: `cannot read evidence file: ${error instanceof Error ? error.message : String(error)}`,
      path: relativePath,
    });
    return { records, findings };
  }

  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      findings.push({
        code: VALIDATION_CODES.evidenceParse,
        message: `line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        path: relativePath,
      });
      continue;
    }
    records.push(parsed as EvidenceRecord);
  }
  return { records, findings };
}

function validateRecordShape(record: unknown, relativePath: string): TreeValidationFinding[] {
  const findings: TreeValidationFinding[] = [];
  const push = (message: string, target?: string): void => {
    findings.push({
      code: VALIDATION_CODES.evidenceSchema,
      message,
      path: relativePath,
      ...(target === undefined ? {} : { target }),
    });
  };

  if (!isRecord(record)) {
    push("record must be a JSON object");
    return findings;
  }

  const id = record["id"];
  const node = record["node"];
  const claim = record["claim"];
  const sources = record["sources"];

  if (typeof id !== "string" || id.trim().length === 0) {
    push("missing non-empty id");
  }
  if (typeof node !== "string" || node.trim().length === 0) {
    push("missing non-empty node", typeof id === "string" ? id : undefined);
  } else if (node.startsWith("/") || node.split("/").includes("..")) {
    push("node must be a tree-relative path", typeof id === "string" ? id : undefined);
  }
  if (typeof claim !== "string" || claim.trim().length === 0) {
    push("missing non-empty claim", typeof id === "string" ? id : undefined);
  }
  if (record["kind"] !== undefined && (typeof record["kind"] !== "string" || !EVIDENCE_KINDS.has(record["kind"]))) {
    push(`kind must be one of ${[...EVIDENCE_KINDS].join(", ")}`, typeof id === "string" ? id : undefined);
  }
  if (
    record["confidence"] !== undefined &&
    (typeof record["confidence"] !== "string" || !CONFIDENCE_LEVELS.has(record["confidence"]))
  ) {
    push(`confidence must be one of ${[...CONFIDENCE_LEVELS].join(", ")}`, typeof id === "string" ? id : undefined);
  }
  if (record["validAt"] !== undefined && typeof record["validAt"] !== "string") {
    push("validAt must be a date string", typeof id === "string" ? id : undefined);
  }

  for (const field of ["supersedes", "contradicts", "dependsOn"] as const) {
    const value = record[field];
    if (value !== undefined && stringArray(value) === undefined) {
      push(`${field} must be an array of claim ids`, typeof id === "string" ? id : undefined);
    }
  }

  if (!Array.isArray(sources) || sources.length === 0) {
    push("sources must be a non-empty array", typeof id === "string" ? id : undefined);
    return findings;
  }

  for (const [index, source] of sources.entries()) {
    if (!isRecord(source)) {
      push(`sources[${index}] must be an object`, typeof id === "string" ? id : undefined);
      continue;
    }
    if (typeof source["path"] !== "string" || source["path"].trim().length === 0) {
      push(`sources[${index}].path is required`, typeof id === "string" ? id : undefined);
    }
    if (source["repo"] !== undefined && typeof source["repo"] !== "string") {
      push(`sources[${index}].repo must be a string`, typeof id === "string" ? id : undefined);
    }
    if (source["line"] !== undefined && (!Number.isInteger(source["line"]) || (source["line"] as number) < 1)) {
      push(`sources[${index}].line must be a positive integer`, typeof id === "string" ? id : undefined);
    }
    if (source["quote"] !== undefined && typeof source["quote"] !== "string") {
      push(`sources[${index}].quote must be a string`, typeof id === "string" ? id : undefined);
    }
  }

  if (record["confidence"] === "verified") {
    const hasAnchoredSource = sources.some(
      (source) =>
        isRecord(source) &&
        typeof source["path"] === "string" &&
        source["path"].trim().length > 0 &&
        Number.isInteger(source["line"]) &&
        typeof source["quote"] === "string" &&
        source["quote"].trim().length > 0,
    );
    if (!hasAnchoredSource) {
      findings.push({
        code: VALIDATION_CODES.evidenceMissingSource,
        message: "verified evidence needs at least one source with path, line, and quote",
        path: relativePath,
        ...(typeof id === "string" ? { target: id } : {}),
      });
    }
  }

  return findings;
}

function parseDate(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function readSourcesMap(root: string): Record<string, string> {
  const path = join(root, EVIDENCE_DIRECTORY, "sources.json");
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!isRecord(parsed)) {
      return {};
    }
    const repos = isRecord(parsed["repos"]) ? parsed["repos"] : parsed;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(repos)) {
      if (typeof value === "string" && value.trim().length > 0) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function resolveSourcePath(
  root: string,
  source: EvidenceSource,
  sourcesMap: Record<string, string>,
  sourceRoot: string | undefined,
): string | undefined {
  const mapped = source.repo === undefined ? undefined : sourcesMap[source.repo];
  if (mapped !== undefined) {
    const base = isAbsolute(mapped) ? mapped : join(root, mapped);
    return join(base, source.path);
  }
  if (sourceRoot === undefined) {
    return undefined;
  }
  if (isAbsolute(source.path) || source.repo === undefined) {
    return join(sourceRoot, source.path);
  }
  // An unmapped repo may be a sibling checkout under a parent directory, or the
  // single checkout itself. Accept whichever layout actually exists.
  const nested = join(sourceRoot, source.repo, source.path);
  return existsSync(nested) ? nested : join(sourceRoot, source.path);
}

function describeSource(source: EvidenceSource): string {
  return toPosixPath(source.repo === undefined ? source.path : join(source.repo, source.path));
}

function checkSource(
  root: string,
  record: EvidenceRecord,
  source: EvidenceSource,
  relativePath: string,
  sourcesMap: Record<string, string>,
  sourceRoot: string | undefined,
): TreeValidationFinding[] {
  if (source.quote === undefined || source.quote.trim().length === 0) {
    return [];
  }
  const resolved = resolveSourcePath(root, source, sourcesMap, sourceRoot);
  if (resolved === undefined) {
    return [];
  }
  const displayPath = describeSource(source);
  if (!existsSync(resolved)) {
    return [
      {
        code: VALIDATION_CODES.evidenceSourceMissing,
        message: `source file not found: ${displayPath}`,
        path: relativePath,
        target: record.id,
      },
    ];
  }
  if (source.line === undefined) {
    return [];
  }
  let lines: string[];
  try {
    lines = readFileSync(resolved, "utf-8").split(/\r?\n/u);
  } catch {
    return [
      {
        code: VALIDATION_CODES.evidenceSourceMissing,
        message: `source file is unreadable: ${displayPath}`,
        path: relativePath,
        target: record.id,
      },
    ];
  }
  if (source.line > lines.length) {
    return [
      {
        code: VALIDATION_CODES.evidenceSourceLine,
        message: `source line ${source.line} is outside ${displayPath} (${lines.length} lines)`,
        path: relativePath,
        target: record.id,
      },
    ];
  }
  if (!lines[source.line - 1]?.includes(source.quote)) {
    return [
      {
        code: VALIDATION_CODES.evidenceSourceQuote,
        message: `quote not found on line ${source.line} of ${displayPath}`,
        path: relativePath,
        target: record.id,
      },
    ];
  }
  return [];
}

export function collectEvidenceFindings(root: string, options: EvidenceVerifyOptions = {}): EvidenceCollection {
  const evidenceRoot = join(root, EVIDENCE_DIRECTORY);
  const files = walkJsonlFiles(evidenceRoot);
  if (files.length === 0) {
    return { count: 0, findings: [] };
  }

  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_EVIDENCE_AGE_DAYS;
  const sourcesMap = readSourcesMap(root);
  const findings: TreeValidationFinding[] = [];
  const records: Array<{ record: EvidenceRecord; relativePath: string }> = [];
  const seenIds = new Map<string, string>();

  for (const absolutePath of files) {
    const relativePath = toPosixPath(relative(root, absolutePath));
    const parsed = parseEvidenceFile(absolutePath, relativePath);
    findings.push(...parsed.findings);
    for (const record of parsed.records) {
      findings.push(...validateRecordShape(record, relativePath));
      if (!isRecord(record)) {
        continue;
      }
      records.push({ record, relativePath });
    }
  }

  const ids = new Set<string>();
  for (const { record, relativePath } of records) {
    if (typeof record.id !== "string" || record.id.length === 0) {
      continue;
    }
    ids.add(record.id);
    const previous = seenIds.get(record.id);
    if (previous !== undefined) {
      findings.push({
        code: VALIDATION_CODES.evidenceDuplicateId,
        message: `duplicate evidence id (also in ${previous})`,
        path: relativePath,
        target: record.id,
      });
    } else {
      seenIds.set(record.id, relativePath);
    }
  }

  for (const { record, relativePath } of records) {
    if (typeof record.id !== "string" || typeof record.node !== "string" || typeof record.claim !== "string") {
      continue;
    }

    if (!existsSync(join(root, record.node))) {
      findings.push({
        code: VALIDATION_CODES.evidenceNodeMissing,
        message: `evidence node does not exist: ${record.node}`,
        path: relativePath,
        target: record.id,
      });
    }

    if (record.validAt !== undefined) {
      const timestamp = parseDate(record.validAt);
      if (timestamp === undefined) {
        findings.push({
          code: VALIDATION_CODES.evidenceSchema,
          message: `validAt is not a valid date: ${record.validAt}`,
          path: relativePath,
          target: record.id,
        });
      } else if (Date.now() - timestamp > maxAgeDays * 24 * 60 * 60 * 1000) {
        findings.push({
          code: VALIDATION_CODES.evidenceStale,
          message: `evidence is older than ${maxAgeDays} days (validAt ${record.validAt})`,
          path: relativePath,
          target: record.id,
        });
      }
    }

    for (const target of record.supersedes ?? []) {
      if (!ids.has(target)) {
        findings.push({
          code: VALIDATION_CODES.evidenceSupersedesMissing,
          message: `supersedes target does not exist: ${target}`,
          path: relativePath,
          target: record.id,
        });
      }
    }

    for (const target of record.contradicts ?? []) {
      if (!ids.has(target)) {
        findings.push({
          code: VALIDATION_CODES.evidenceContradiction,
          message: `contradiction target does not exist: ${target}`,
          path: relativePath,
          target: record.id,
        });
      } else if (record.resolution === undefined || record.resolution.trim().length === 0) {
        findings.push({
          code: VALIDATION_CODES.evidenceContradiction,
          message: `unresolved contradiction with ${target}`,
          path: relativePath,
          target: record.id,
        });
      }
    }

    for (const source of record.sources ?? []) {
      if (!isRecord(source)) {
        continue;
      }
      findings.push(
        ...checkSource(root, record, source as EvidenceSource, relativePath, sourcesMap, options.sourceRoot),
      );
    }
  }

  return { count: records.length, findings };
}
