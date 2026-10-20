const fs = require('node:fs');
const path = require('node:path');
const { buildPublicExportPlan } = require('./create-public-export');

const projectRoot = path.join(__dirname, '..');
const TEXT_EXTENSIONS = new Set(['.js', '.json', '.md']);

// These patterns deliberately require a planning or review context. Product versions, board
// coordinates, and the R1–R10 architecture rule names remain valid public text.
const INTERNAL_PATTERNS = Object.freeze([
  Object.freeze({
    label: 'plan marker',
    pattern: /\bP3-\d+[a-z]?\b|\b(?:pre-|phase\s+)B\d{1,2}[a-z]?\b/u,
  }),
  Object.freeze({
    label: 'internal code in a comment',
    pattern: /^\s*\/\/.*\b(?:[BVIQ]\d+(?:[a-z]|-\d+)?|R\d+(?:[a-z]|-\d+)|重要-\d+)\b/u,
  }),
  Object.freeze({
    label: 'internal code in an identifier',
    pattern: /\bid\s*:\s*['"](?:[ABGIQTV]\d+(?:[a-z]|-\d+)?|R\d+[a-z]|重要-\d+)/u,
  }),
  Object.freeze({
    label: 'internal planning context',
    pattern: /\b(?:refactor(?:\s+plan)?|violation|baseline|review|batch)\s+(?:[ABGIVQ]\d+(?:[a-z]|-\d+)?|R\d+(?:[a-z]|-\d+))\b/iu,
  }),
]);

function publicTextFiles({ sourceRoot = projectRoot } = {}) {
  return buildPublicExportPlan({ sourceRoot }).filter((file) =>
    (file === 'README.md' || file.startsWith('docs/') || file.startsWith('scripts/') ||
      file.startsWith('src/') || file.startsWith('test/')) && TEXT_EXTENSIONS.has(path.extname(file)));
}

function findInternalReferences(text) {
  const lines = String(text).split(/\r?\n/u);
  const issues = [];
  for (const [index, line] of lines.entries()) {
    for (const { label, pattern } of INTERNAL_PATTERNS) {
      const match = line.match(pattern);
      if (match) issues.push({ label, line: index + 1, marker: match[0] });
    }
  }
  return issues;
}

function findPublicTextIssues({ sourceRoot = projectRoot } = {}) {
  const issues = [];
  for (const relativePath of publicTextFiles({ sourceRoot })) {
    const source = fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8');
    for (const issue of findInternalReferences(source)) {
      issues.push(`${relativePath}:${issue.line} contains ${issue.label}: ${issue.marker}`);
    }
  }
  return issues;
}

if (require.main === module) {
  const issues = findPublicTextIssues();
  if (issues.length) {
    console.error(`Public text check failed:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`Public text check passed: ${publicTextFiles().length} files.`);
  }
}

module.exports = { findInternalReferences, findPublicTextIssues, publicTextFiles };
