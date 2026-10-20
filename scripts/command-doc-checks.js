const fs = require('node:fs');
const path = require('node:path');
const defaultCatalog = require('../website/commandCatalog');
const { buildHelpSections } = require('../src/commands/help');
const { COMMAND_DOCS_PATH, renderCommandDocs } = require('./render-command-docs');

// Checks that the documents and the website follow the command catalog. scripts/check-project.js
// runs them for `npm run check`, and test/commandDocs.test.js exercises them. Nothing here writes a file.

const COMMAND_SECTION_HEADING = '公開指令';
const WEBSITE_ROOT = path.resolve(__dirname, '..', 'website');
const WEBSITE_TEXT_EXTENSIONS = new Set(['.html', '.js']);

// A slash-command mention in prose: /command, then at most one subcommand or one slash-joined list
// such as "add/list/delete". Pieces of paths and URLs (docs/COMMANDS.md, <dir>/file, ./games) are skipped.
const MENTION_PATTERN = /(?<![A-Za-z0-9_./:<>\\-])\/([a-z][a-z0-9-]*)(?: ([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*))?/gu;

function findMentions(text) {
  return [...String(text).matchAll(MENTION_PATTERN)].map((match) => ({
    text: match[0],
    command: match[1],
    subcommands: match[2] ? match[2].split('/') : [],
  }));
}

// Every mention must name a live command. A mention that names subcommands must name real ones, but
// only when the command has subcommands, so "/weather city" and "/work admin-remind force" pass.
function classifyMentions(text, catalog) {
  const removed = new Set(catalog.REMOVED_COMMANDS);
  const problems = [];
  for (const mention of findMentions(text)) {
    const entry = catalog.COMMAND_CATALOG.find((candidate) => candidate.name === mention.command);
    if (removed.has(mention.command)) {
      problems.push({ removed: true, message: `${mention.text}: /${mention.command} was removed` });
    } else if (!entry) {
      problems.push({ removed: false, message: `${mention.text}: /${mention.command} is not in the catalog` });
    } else if (entry.subcommands.length > 0) {
      for (const subcommand of mention.subcommands) {
        if (removed.has(`${entry.name} ${subcommand}`)) {
          problems.push({ removed: true, message: `${mention.text}: /${entry.name} ${subcommand} was removed` });
        } else if (!entry.subcommands.includes(subcommand)) {
          problems.push({ removed: false, message: `${mention.text}: /${entry.name} has no subcommand ${subcommand}` });
        }
      }
    }
  }
  return problems;
}

function findStaleMentions(text, catalog = defaultCatalog) {
  return classifyMentions(text, catalog).map((problem) => problem.message);
}

function findRemovedMentions(text, catalog = defaultCatalog) {
  return classifyMentions(text, catalog).filter((problem) => problem.removed).map((problem) => problem.message);
}

function findOperationsCommandSection(readme) {
  const pattern = new RegExp(`\\n## ${COMMAND_SECTION_HEADING}\\n([\\s\\S]*?)(?=\\n## |$)`, 'u');
  const match = pattern.exec(`\n${readme}`);
  return match ? match[1] : null;
}

// The operations guide command section follows the catalog: it names only live commands, it lists every command
// that /help lists, and no removed command appears anywhere else in the file. The setup chapters
// mention paths of their own, so outside the section only removed names are looked for.
function findOperationsIssues(readme, catalog = defaultCatalog) {
  const section = findOperationsCommandSection(readme);
  if (section === null) return [`docs/OPERATIONS.md has no "${COMMAND_SECTION_HEADING}" section`];
  const issues = findStaleMentions(section, catalog).map((issue) => `${COMMAND_SECTION_HEADING} section: ${issue}`);
  const mentioned = new Set(findMentions(section).map((mention) => mention.command));
  const listedInHelp = new Set(buildHelpSections(catalog).flatMap(({ entries }) => entries.map(({ name }) => name)));
  for (const name of listedInHelp) {
    if (!mentioned.has(name)) issues.push(`${COMMAND_SECTION_HEADING} section does not list /${name}`);
  }
  for (const issue of findRemovedMentions(readme.replace(section, ''), catalog)) {
    issues.push(`outside the ${COMMAND_SECTION_HEADING} section: ${issue}`);
  }
  return issues;
}

function describeFirstDifference(expected, actual) {
  const wanted = expected.split('\n');
  const found = actual.split('\n');
  const show = (line) => (line === undefined ? '(end of file)' : JSON.stringify(line.length > 100 ? `${line.slice(0, 97)}...` : line));
  for (let index = 0; index < Math.max(wanted.length, found.length); index += 1) {
    if (wanted[index] !== found[index]) return `line ${index + 1} should be ${show(wanted[index])} but is ${show(found[index])}`;
  }
  return 'the content differs';
}

// docs/COMMANDS.md must be exactly what scripts/render-command-docs.js renders from the catalog.
// The file is only read; regenerate it with `node scripts/render-command-docs.js`.
function findCommandDocsIssues({ docsPath = COMMAND_DOCS_PATH, catalog = defaultCatalog } = {}) {
  let current;
  try {
    current = fs.readFileSync(docsPath, 'utf8');
  } catch (error) {
    return [`docs/COMMANDS.md cannot be read (${error.code || error.message}). Run: node scripts/render-command-docs.js`];
  }
  let expected;
  try {
    expected = renderCommandDocs(catalog);
  } catch (error) {
    return [`docs/COMMANDS.md could not be compared with the command catalog: ${error.message}`];
  }
  const actual = current.replace(/\r\n/gu, '\n');
  if (actual === expected) return [];
  return [`docs/COMMANDS.md is out of date: ${describeFirstDifference(expected, actual)}. Run: node scripts/render-command-docs.js`];
}

// ---- Website text -----------------------------------------------------------------------------

// Quoted strings in a script. Only the ones with Chinese text are meant for people to read; paths,
// ids and other code strings are left alone, so '/api/status' is not taken for a command.
const SCRIPT_STRING = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/gu;
const VISIBLE_ATTRIBUTE = /\b(?:aria-label|title|alt|placeholder|content)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeHtmlEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// What a person reads on an HTML page: the text between tags and the attributes that show text.
// Scripts, styles, comments and all other attributes (links, ids, classes) are skipped.
function extractHtmlText(html) {
  const markup = String(html)
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/giu, ' ');
  const attributes = [...markup.matchAll(VISIBLE_ATTRIBUTE)].map((match) => match[1] ?? match[2]);
  return [markup.replace(/<[^>]*>/gu, ' '), ...attributes].map(decodeHtmlEntities);
}

// The Chinese strings of a script. Tags inside a string are dropped, because a command may sit in <code>.
function extractScriptText(script) {
  return (String(script).match(SCRIPT_STRING) || [])
    .map((literal) => literal.slice(1, -1))
    .filter((text) => /\p{Script=Han}/u.test(text))
    .map((text) => text.replace(/<[^>]*>/gu, ' '));
}

function extractWebsiteText(source, extension) {
  if (extension === '.html') return extractHtmlText(source);
  if (extension === '.js') return extractScriptText(source);
  return [];
}

// Folders that hold tool settings or build output, never page content: every folder whose name starts
// with a dot (.vite, .wrangler, .output, .git, ...) and the build output folders. Scripts in them are
// bundles and caches, so their strings are not text the site shows to people.
const SKIPPED_WEBSITE_DIRECTORIES = new Set(['dist', 'node_modules']);

function isSkippedWebsiteDirectory(name) {
  return name.startsWith('.') || SKIPPED_WEBSITE_DIRECTORIES.has(name);
}

// Every page and script under the website, as paths relative to its root with "/" separators.
function listWebsiteTextFiles(websiteRoot = WEBSITE_ROOT) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!isSkippedWebsiteDirectory(entry.name)) visit(fullPath);
      } else if (entry.isFile() && WEBSITE_TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(path.relative(websiteRoot, fullPath).split(path.sep).join('/'));
      }
    }
  };
  visit(websiteRoot);
  return files.sort();
}

// Every command the website text mentions must exist and must not be removed. This covers all pages
// and scripts, including the support texts, the game pages and the game client.
function findWebsiteIssues({ websiteRoot = WEBSITE_ROOT, catalog = defaultCatalog } = {}) {
  const issues = [];
  for (const file of listWebsiteTextFiles(websiteRoot)) {
    const source = fs.readFileSync(path.join(websiteRoot, file), 'utf8');
    const messages = new Set(extractWebsiteText(source, path.extname(file).toLowerCase())
      .flatMap((text) => findStaleMentions(text, catalog)));
    for (const message of messages) issues.push(`website/${file}: ${message}`);
  }
  return issues;
}

module.exports = {
  COMMAND_SECTION_HEADING,
  WEBSITE_ROOT,
  extractWebsiteText,
  findCommandDocsIssues,
  findMentions,
  findOperationsCommandSection,
  findOperationsIssues,
  findRemovedMentions,
  findStaleMentions,
  findWebsiteIssues,
  listWebsiteTextFiles,
};
