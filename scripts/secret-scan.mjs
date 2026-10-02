#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const trackedFiles = execFileSync('git', ['-C', repositoryRoot, 'ls-files', '-z'], {
  encoding: 'utf8',
}).split('\0').filter(Boolean);

const findings = [];
for (const relativePath of trackedFiles) {
  if (/(^|\/)\.env(?:$|\.)|(^|\/)[^/]+\.env$/i.test(relativePath)) {
    findings.push({ category: 'tracked environment file', path: relativePath });
  }
}
const highConfidencePatterns = [
  ['OpenAI API key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['bearer authorization value', /authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi],
];
const environmentNames = /(?:OPENAI_API_KEY|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:PASSWORD|TOKEN|SECRET))$/i;
const assignment = /^[ \t]*([A-Z][A-Z0-9_]*)[ \t]*[:=][ \t]*([^#\r\n]*)/gm;
const safeValues = new Set(['', 'bankapp_local', 'root_local', 'change-me', 'change-me-local', 'changeme', 'placeholder', 'your-value-here']);
const environmentLike = /(^|\/)(\.env(?:\.[^/]+)?|[^/]+\.(?:properties|ya?ml|json|toml))$/i;

for (const relativePath of trackedFiles) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  let content;
  try { content = readFileSync(absolutePath, 'utf8'); } catch { continue; }
  if (content.includes('\0') || Buffer.byteLength(content) > 2 * 1024 * 1024) continue;

  for (const [category, pattern] of highConfidencePatterns) {
    if (pattern.test(content)) findings.push({ category, path: relativePath });
    pattern.lastIndex = 0;
  }

  if (environmentLike.test(relativePath)) {
    for (const match of content.matchAll(assignment)) {
      const name = match[1];
      const value = match[2].trim().replace(/^['"]|['"]$/g, '');
      if (environmentNames.test(name) && !value.startsWith('${') && !safeValues.has(value.toLowerCase())) {
        findings.push({ category: `suspicious ${name} assignment`, path: relativePath });
      }
    }
  }
}

const uniqueFindings = [...new Map(findings.map((finding) => [`${finding.category}:${finding.path}`, finding])).values()];
if (uniqueFindings.length > 0) {
  console.error('Secret scan failed. Findings (values intentionally omitted):');
  for (const finding of uniqueFindings) console.error(`- ${finding.category}: ${finding.path}`);
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed: ${trackedFiles.length} tracked files inspected; no high-confidence credentials found.`);
}
