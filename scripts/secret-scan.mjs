#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repositoryRoot = path.resolve(scriptDirectory, "..");

const highConfidencePatterns = [
  ["OpenAI API key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  [
    "bearer authorization value",
    /authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  ],
];
const environmentNames =
  /(?:OPENAI_API_KEY|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:PASSWORD|TOKEN|SECRET))$/i;
const assignment = /^[ \t]*([A-Z][A-Z0-9_]*)[ \t]*[:=][ \t]*([^#\r\n]*)/gm;
const smtpAssignment =
  /^[ \t]*((?:spring[._-])?mail[._-](?:username|password|token)|smtp[._-](?:username|password|token)|SMTP_(?:USERNAME|PASSWORD|TOKEN))[ \t]*[:=][ \t]*([^#\r\n]*)/gim;
const safeValues = new Set([
  "",
  "bankapp_local",
  "root_local",
  "change-me",
  "change-me-local",
  "changeme",
  "example",
  "placeholder",
  "your-value-here",
]);
const environmentLike =
  /(^|\/)(\.env(?:\.[^/]+)?|[^/]+\.(?:properties|ya?ml|json|toml))$/i;

function normalizedValue(rawValue) {
  return rawValue.trim().replace(/^['"]|['"]$/g, "");
}

function isSafeConfigurationValue(value) {
  return (
    safeValues.has(value.toLowerCase()) ||
    value.startsWith("${") ||
    /^<[^>]+>$/.test(value) ||
    /^\{\{[^}]+\}\}$/.test(value)
  );
}

export function scanContent(relativePath, content) {
  const findings = [];
  if (content.includes("\0") || Buffer.byteLength(content) > 2 * 1024 * 1024)
    return findings;

  for (const [category, pattern] of highConfidencePatterns) {
    if (pattern.test(content)) findings.push({ category, path: relativePath });
    pattern.lastIndex = 0;
  }

  if (environmentLike.test(relativePath)) {
    for (const match of content.matchAll(assignment)) {
      const name = match[1];
      const value = normalizedValue(match[2]);
      if (environmentNames.test(name) && !isSafeConfigurationValue(value)) {
        findings.push({
          category: `suspicious ${name} assignment`,
          path: relativePath,
        });
      }
    }
  }

  for (const match of content.matchAll(smtpAssignment)) {
    const name = match[1];
    const value = normalizedValue(match[2]);
    if (!isSafeConfigurationValue(value)) {
      findings.push({
        category: `hard-coded SMTP credential in ${name}`,
        path: relativePath,
      });
    }
  }

  return findings;
}

function git(args, options = {}) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function trackedTreeFindings() {
  const trackedFiles = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  const findings = [];
  for (const relativePath of trackedFiles) {
    if (/(^|\/)\.env(?:$|\.)|(^|\/)[^/]+\.env$/i.test(relativePath)) {
      findings.push({
        category: "tracked environment file",
        path: relativePath,
        scope: "current",
      });
    }
    const absolutePath = path.join(repositoryRoot, relativePath);
    let content;
    try {
      content = readFileSync(absolutePath, "utf8");
    } catch {
      continue;
    }
    findings.push(
      ...scanContent(relativePath, content).map((finding) => ({
        ...finding,
        scope: "current",
      })),
    );
  }
  return { findings, trackedFileCount: trackedFiles.length };
}

function historyFindings() {
  const commits = git(["rev-list", "--all"]).split("\n").filter(Boolean);
  const seenBlobs = new Set();
  const findings = [];

  for (const commit of commits) {
    const tree = git(["ls-tree", "-r", "-z", "--full-tree", commit]);
    for (const entry of tree.split("\0").filter(Boolean)) {
      const match = entry.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/s);
      if (!match) continue;
      const [, blob, relativePath] = match;
      const identity = `${blob}:${relativePath}`;
      if (seenBlobs.has(identity)) continue;
      seenBlobs.add(identity);

      const result = spawnSync(
        "git",
        ["-C", repositoryRoot, "cat-file", "blob", blob],
        {
          encoding: "utf8",
          maxBuffer: 3 * 1024 * 1024,
        },
      );
      if (result.status !== 0 || typeof result.stdout !== "string") continue;
      findings.push(
        ...scanContent(relativePath, result.stdout).map((finding) => ({
          ...finding,
          scope: "history",
          commit,
        })),
      );
    }
  }

  return {
    findings,
    commitCount: commits.length,
    uniqueBlobCount: seenBlobs.size,
  };
}

export function runScan() {
  const current = trackedTreeFindings();
  const history = historyFindings();
  const findings = [...current.findings, ...history.findings];
  const uniqueFindings = [
    ...new Map(
      findings.map((finding) => [
        `${finding.category}:${finding.path}:${finding.scope}:${finding.commit ?? ""}`,
        finding,
      ]),
    ).values(),
  ];

  if (uniqueFindings.length > 0) {
    console.error(
      "Secret scan failed. Findings (values intentionally omitted):",
    );
    for (const finding of uniqueFindings) {
      const location = finding.commit
        ? `history commit ${finding.commit.slice(0, 12)}`
        : "current tracked tree";
      console.error(`- ${finding.category}: ${finding.path} (${location})`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Secret scan passed: ${current.trackedFileCount} tracked files and ` +
      `${history.uniqueBlobCount} unique historical blobs across ${history.commitCount} commits inspected; ` +
      "no high-confidence credentials found.",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) runScan();
