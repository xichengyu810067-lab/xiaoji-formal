// Architecture boundary checks, run by `npm run check` and usable on their own:
//   node scripts/check-boundaries.js [--report] [--root <dir>] [--baseline <file>] [--rule R6]
//
// The rules keep the dependency direction between the bot's layers one-way and give every database
// table one owner. Layers, from the top: entry (commands, events, handlers, index.js, loadCommands.js,
// deploy-commands.js) -> coordinators -> systems -> storage engines -> platform and utils.
// src/services holds modules that have not moved into a system yet and is frozen.
//
// Violations that already existed when the checks were introduced are listed in
// scripts/boundary-baseline.json. The file is a ratchet:
//   - a violation that is not in the baseline fails the check;
//   - a baseline entry whose violation is gone, or occurs less often than recorded, also fails,
//     so the entry is deleted in the same change and the file can only shrink.
//
// How the sources are read: a small scanner (scanSource) tells code from comments, strings, template
// literals and regular expressions, and regular expressions then look at the right part of each file.
// Known blind spots:
//   - SQL is read from the text of string and template literals, with upper-case keywords: FROM (also
//     a comma list), JOIN, INTO, UPDATE [OR ...], ALTER TABLE, RENAME TO, DROP TABLE, CREATE TABLE,
//     CREATE INDEX or TRIGGER ... ON. A table name counts when a CREATE TABLE statement in src declares
//     it, in any case, quoted with "", `` or [], with or without a schema prefix. The escapes \n, \t and
//     \r count as white space. Not seen:
//       - lower-case keywords, and table names built at run time or from several literals;
//       - PRAGMA table_info(t), REINDEX, ANALYZE and ATTACH;
//       - CREATE TEMP TABLE and CREATE TEMPORARY TABLE;
//       - a table name in single quotes (FROM 't') or after a SQL comment (FROM /* c */ t, FROM -- c);
//       - the rest of a FROM list after a subquery or a table-valued function
//         (FROM (SELECT ...) s, t and FROM json_each(x), t);
//       - a keyword glued to the word next to it by any other escape that stands for white space
//         (\x20, \u0020, \f, \v) or by a line continuation.
//   - Modules loaded with a computed path (the command and event loaders) are not seen.
//   - Hook names built at run time are not seen, except through the forwarders listed below.
//   - A file the scanner cannot read reliably (a string, template or comment that never closes) is
//     reported instead of being guessed at. A slash that does not open a regular expression closing on
//     its own line is read as a division, and that is not reported: this is how a regular expression
//     right after `if (...)`, one that never closes, or one that starts a line after a statement
//     without its semicolon (`n++` and then `/x/.test(s)` on the next line) ends up read as code.
const fs = require('node:fs');
const path = require('node:path');
const {
  assertAllowedPath,
  buildPublicExportPlan,
  isIgnoredUntracked,
  listIgnoredUntracked,
} = require('./create-public-export');

const PROJECT_ROOT = path.join(__dirname, '..');
const BASELINE_FILE = 'scripts/boundary-baseline.json';
const CONTRACT_FILE = 'docs/EXTENSION_CONTRACT.md';
const MANIFEST_FILE = 'public-export/manifest.json';

const RULES = Object.freeze({
  R1: 'Entry code does not load a storage engine.',
  R2: 'Only entry code loads commands or events.',
  R3: 'Systems and services do not load coordinators (a registered one-line adapter may forward to one), and coordinators do not load entry code.',
  R4: 'The economy does not load casino, work, games, community or conversation code.',
  R5: 'Platform and utils do not load systems, services or coordinators.',
  R6: 'A database table is named in SQL only by the files that own it.',
  R7: 'Every extension hook the code runs is listed in docs/EXTENSION_CONTRACT.md.',
  R8: 'Adapters are a one-line forward, and production code does not load the legacy src/games root or an adapter that forwards to a coordinator.',
  R9: 'src/services is frozen: it gets no new files.',
  R10: 'Every file under src and test is in the public export, at a path the export accepts. Left out: tests of the private live-test tools, the bot\'s runtime data in src/data, and files git ignores. Exported code outside test does not name the private tools/live-test.',
});

// Baseline entries state how an exception is expected to be resolved: a general cleanup, a decision
// that is still open, or work that has not yet been scheduled.
const DISPOSITION_PATTERN = /^(?:cleanup|pending-decision|unscheduled)$/u;
const BASELINE_FIELDS = new Set(['id', 'rule', 'file', 'target', 'count', 'disposition', 'note']);

// ---------------------------------------------------------------------------------------------
// Layers and systems
// ---------------------------------------------------------------------------------------------

const ENTRY_FILES = new Set(['deploy-commands.js', 'src/index.js', 'src/loadCommands.js']);
const ENTRY_DIRECTORIES = Object.freeze(['src/commands', 'src/events', 'src/handlers']);

// R1: the modules that open a database or a data store. The legacy board storage paths are the same
// modules behind adapters, so loading them counts too.
const STORAGE_ENGINES = new Set([
  'src/services/coinDatabase.js',
  'src/systems/safety/sideEffectLedger.js',
  'src/systems/safety/ledgerStore.js',
  'src/systems/games/board/storage/boardSchema.js',
  'src/systems/games/board/storage/sqliteBoardStore.js',
  'src/games/storage/boardSchema.js',
  'src/games/storage/sqliteBoardStore.js',
  'src/utils/guildConfig.js',
]);

// R5: the one platform module that may load services, because it assembles the startup checks.
const PLATFORM_EXCEPTIONS = new Set(['src/platform/runtimeDataPreflight.js']);

// A system is a directory under src/systems plus the src/services files that have not moved yet.
const SYSTEMS = Object.freeze({
  economy: {
    directories: ['src/systems/economy'],
    files: [
      'src/services/coinDatabase.js',
      'src/services/coinAdminAddService.js',
      'src/services/coinService.js',
      'src/services/coinWalletService.js',
      'src/services/coinCampaignService.js',
      'src/services/bankService.js',
      'src/services/chipService.js',
      'src/services/luxuryService.js',
    ],
  },
  casino: {
    directories: ['src/systems/casino'],
    files: [
      'src/services/casinoService.js',
      'src/services/casinoFacilityService.js',
      'src/services/venueService.js',
    ],
  },
  work: {
    directories: ['src/systems/work'],
    files: ['src/services/workService.js'],
  },
  games: {
    directories: ['src/systems/games', 'src/games'],
    files: [
      'src/services/gameService.js',
      'src/services/gameRewardPolicy.js',
      'src/services/gameServer.js',
    ],
  },
  // featurePlatformService is not part of community: it also holds the reward ledger, which the economy
  // calls, so it is listed as rewardLedger until the ledger moves into a module of its own.
  community: {
    directories: ['src/systems/community'],
    files: [
      'src/services/dailyDiscussionService.js',
      'src/services/dailyDiscussionCorpus.js',
      'src/services/dailyRiddleService.js',
      'src/services/dailyRiddleCorpus.js',
      'src/services/wordChainService.js',
      'src/services/wordChainLexicon.js',
      'src/services/numberChainService.js',
      'src/services/numberExpressionService.js',
      'src/services/pollService.js',
      'src/services/releaseAnnouncementService.js',
      'src/services/welcomeService.js',
      'src/services/messageFeatureRouter.js',
      'src/services/chainReactionDelivery.js',
    ],
  },
  conversation: {
    directories: ['src/systems/conversation'],
    files: [
      'src/services/aiService.js',
      'src/services/aiArchiveService.js',
      'src/services/chatStyleService.js',
      'src/services/conversationHistoryService.js',
      'src/services/conversationModeService.js',
      'src/services/memoryService.js',
      'src/services/mentionService.js',
      'src/services/romanceModeService.js',
    ],
  },
  safety: {
    directories: ['src/systems/safety'],
    files: [],
  },
  rewardLedger: {
    directories: [],
    files: ['src/services/featurePlatformService.js'],
  },
});

// R4: what the economy must not load.
const ECONOMY_FORBIDDEN_SYSTEMS = new Set(['casino', 'work', 'games', 'community', 'conversation']);

function isUnder(file, directory) {
  return file.startsWith(`${directory}/`);
}

function isEntry(file) {
  return ENTRY_FILES.has(file) || ENTRY_DIRECTORIES.some((directory) => isUnder(file, directory));
}

function systemPaths(name) {
  const system = SYSTEMS[name];
  return [...system.directories.map((directory) => `${directory}/`), ...system.files];
}

// An owner path ending in a slash is a directory; any other owner path is one file.
function belongsTo(file, paths) {
  return paths.some((owned) => (owned.endsWith('/') ? file.startsWith(owned) : file === owned));
}

function systemOf(file) {
  if (!file) return null;
  return Object.keys(SYSTEMS).find((name) => belongsTo(file, systemPaths(name))) || null;
}

// ---------------------------------------------------------------------------------------------
// R6: table owners
// ---------------------------------------------------------------------------------------------

// The coin database creates and migrates the tables of every system, so its own SQL may name any.
const SCHEMA_OWNER_FILES = new Set(['src/services/coinDatabase.js']);

// The first family whose pattern matches a table owns it; the work family comes before the economy
// family because the economy pattern also matches the coin_ tables of the work system.
const TABLE_FAMILIES = Object.freeze([
  {
    name: 'work',
    tables: /^(?:coin_jobs|coin_work_.+|coin_primary_.+|coin_payroll_history)$/u,
    owners: systemPaths('work'),
  },
  {
    name: 'economy',
    tables: /^(?:coin_.+|chip_.+|luxury_.+|casino_loans|casino_ledger)$/u,
    owners: systemPaths('economy'),
  },
  {
    name: 'casino',
    tables: /^casino_(?:games|blackjack_sessions|duel_tower_runs.*|lodging_bookings|venue_.+)$/u,
    owners: systemPaths('casino'),
  },
  {
    name: 'reward ledger',
    tables: /^reward_grants(?:_v2)?$/u,
    owners: systemPaths('rewardLedger'),
  },
  {
    name: 'feature platform',
    tables: /^feature_.+$/u,
    owners: ['src/services/featurePlatformService.js'],
  },
  {
    name: 'daily events',
    tables: /^daily_.+$/u,
    owners: ['src/services/dailyDiscussionService.js', 'src/services/dailyRiddleService.js'],
  },
  {
    name: 'number chain',
    tables: /^number_chain_.+$/u,
    owners: ['src/services/numberChainService.js'],
  },
  {
    name: 'word chain',
    tables: /^text_chain_.+$/u,
    owners: ['src/services/wordChainService.js'],
  },
  {
    name: 'release announcements',
    tables: /^(?:github_releases|release_announcement_.+)$/u,
    owners: ['src/services/releaseAnnouncementService.js'],
  },
  {
    name: 'games',
    tables: /^(?:board_.+|discord_game_.+|game_.+)$/u,
    owners: systemPaths('games'),
  },
  {
    name: 'conversation',
    tables: new RegExp('^(?:user_chat_preferences|user_romance_preferences|access_audit|ai_events|'
      + 'archive_identity|deletion_receipts|import_quarantine|import_receipts|private_summaries|'
      + 'public_messages|xiaoji_memory_consent|xiaoji_memory_preferences)$', 'u'),
    owners: systemPaths('conversation'),
  },
  {
    name: 'safety ledger',
    tables: /^(?:identity|operations|reaction_fences|watermarks)$/u,
    owners: systemPaths('safety'),
  },
]);

function familyOf(table) {
  return TABLE_FAMILIES.find((family) => family.tables.test(table)) || null;
}

// ---------------------------------------------------------------------------------------------
// R7: extension hooks
// ---------------------------------------------------------------------------------------------

// Functions that hand a hook name to runHook after putting `prefix` in front of it. `argIndex` is the
// position of the name among the arguments. Any quoted string that starts with a prefix is also taken
// as a hook name, which covers a name handed to an injected runner instead of to runHook.
const HOOK_FORWARDERS = Object.freeze([
  { name: 'runWorkRoleHook', argIndex: 1, prefix: 'workRole.' },
]);

// ---------------------------------------------------------------------------------------------
// R8: adapters
// ---------------------------------------------------------------------------------------------

// Every .js file below an adapter root is an adapter, and production code does not load it: the
// implementation lives under src/systems and code there loads it directly.
const ADAPTER_ROOTS = Object.freeze(['src/games']);
// Adapters that sit next to modules that did not move, kept so that old require paths still work.
// A module that moves into src/coordinators leaves one of these behind. R3 exempts the one load such an
// adapter is made of (its forward into the coordinator) while the file is registered here and is still a
// one-line forward; R8 then keeps production code from loading it, so nothing inside depends on the old path.
const ADAPTER_FILES = Object.freeze([
  'src/services/aiService.js',
  'src/services/bankService.js',
  'src/services/chipService.js',
  'src/services/coinCampaignService.js',
  'src/services/coinService.js',
  'src/services/coinWalletService.js',
  'src/services/luxuryService.js',
  'src/services/memoryService.js',
  'src/services/mentionService.js',
  'src/services/workService.js',
  'src/systems/community/calendarSystem.js',
  'src/systems/games/unifiedGameRuntime.js',
  'src/systems/reminders/reminderSystem.js',
]);
// An adapter is one forwarding line, or the three-line form of a command-line script that also
// forwards the run.
const ONE_LINE_ADAPTER = /^module\.exports = require\('([^']+)'\);\n$/u;
const CLI_ADAPTER = new RegExp("^const implementation = require\\('([^']+)'\\);\\n"
  + 'if \\(require\\.main === module\\) process\\.exitCode = implementation\\.main\\(\\);\\n'
  + 'module\\.exports = implementation;\\n$', 'u');

// ---------------------------------------------------------------------------------------------
// R9 and R10
// ---------------------------------------------------------------------------------------------

const FROZEN_DIRECTORY = 'src/services';
const EXPORT_CHECKED_DIRECTORIES = Object.freeze(['src', 'test']);
const IGNORED_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

// Runtime data: the bot keeps its JSON stores in src/data (retainedDataSource.js), and the stores and the
// upgrade scripts leave temporary and backup copies next to them. Git ignores all of it (.gitignore:
// **/data/*, except src/data/.gitkeep) and the export never ships it, but it exists in every checkout the
// bot has run in, so R10 skips everything under src/data that is not code. Code is a script or module
// (.js, .cjs, .mjs, .jsx, .ts, .tsx, .mts, .cts), a native addon (.node) or a WebAssembly module
// (.wasm): one there (src/data/x.js) is still refused, even though git ignores it.
const RUNTIME_DATA_PATH = /^src\/data\/(?!.*\.(?:[cm]?js|jsx|tsx?|[cm]ts|node|wasm)$)[^/]+(?:\/[^/]+)*$/iu;

// The one exception to "every test is exported": tests of tooling that stays out of the public export.
// tools/live-test is private, so a test that loads it would fail in the exported copy, which lacks the
// tool. A test-side file is exempt only when both hold:
//   - its path is test/liveTest*.test.js or test/support/liveTest*.js, and
//   - its code names tools/live-test: a string or template literal that is a path through it (a require
//     specifier, say), or the literals 'tools' and 'live-test' as consecutive arguments. A comment, or
//     a sentence that merely mentions it, does not count.
// An exempt file skips both R10 checks: it is meant to stay out of the export, and the export itself
// refuses it by name (create-public-export.js refuses every livetest* file), so its refused path is
// the intended state, not a violation. Every other test, and every file under src, must still be
// exported and have a path the export accepts.
const PRIVATE_TOOL_TEST_PATH = /^test\/(?:liveTest[A-Za-z0-9]*\.test\.js|support\/liveTest[A-Za-z0-9]*\.js)$/u;
const PRIVATE_TOOL_PATH_LITERAL = /^[^\s]*(?:^|\/)tools\/live-test(?:\/[^\s]*)?$/u;
// Exported files that are code, for the check that no exported code outside test names tools/live-test.
const EXPORTED_CODE = /\.[cm]?js$/u;

// ---------------------------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------------------------

// A load is require( or import( with one string or template literal, or `from` and a literal. Only code
// is looked at, so a comment or a string that contains the word is never a load.
const CALL_LOAD_PATTERN = /\b(?:require|import)\s*\(\s*(['"`])/gu;
const FROM_LOAD_PATTERN = /\bfrom\s*(['"`])/gu;

function byCodeUnit(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

// Lists the files below `directory` as sorted, slash-separated paths relative to `root`.
function listFiles(root, directory) {
  const found = [];
  const visit = (relativeDirectory) => {
    const entries = fs.readdirSync(path.join(root, relativeDirectory), { withFileTypes: true })
      .sort((left, right) => byCodeUnit(left.name, right.name));
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile()) found.push(relativePath);
    }
  };
  if (fs.existsSync(path.join(root, directory)) && fs.statSync(path.join(root, directory)).isDirectory()) visit(directory);
  return found;
}

// A word before a slash that makes the slash open a regular expression instead of dividing.
const REGEX_AFTER_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);
const WORD_CHARACTER = /[A-Za-z0-9_$]/u;
// The escapes in literal text that SQL reads as white space.
const SQL_WHITE_SPACE_ESCAPES = new Set(['n', 't', 'r']);

// Reads JavaScript with just enough grammar to tell code from comments, strings, template literals and
// regular expressions. Every view keeps the offsets of the source text, so one position means the same
// line in all of them:
//   code      comments blanked, and the inside of strings, template text and regular expressions blanked;
//             quote marks stay, so a literal is found at its opening quote. Template placeholders
//             (${...}) are code and stay.
//   sql       only the text of string and template literals; U+0001 stands in for everything else, so a
//             table name can never be read across the end of a literal or out of a placeholder. The
//             escapes \n, \t and \r are two spaces here, so they cannot glue a keyword to a name.
//   literals  every string and template literal by the offset of its opening quote: its text, where it
//             ends, and whether a template has placeholders (then the text has U+0001 in their place).
//   problem   null, or why the text could not be read reliably: a string, template or comment that never
//             closes. A slash that might open a regular expression which never closes is not a problem;
//             it is read as a division.
function scanSource(raw) {
  const length = raw.length;
  const lineOf = createLineLocator(raw);
  const code = raw.split('');
  const sql = new Array(length).fill('\u0001');
  const literals = new Map();
  let problem = null;

  const fail = (what, offset) => { problem = problem || `${what} (line ${lineOf(offset)})`; };
  const blank = (from, to) => {
    for (let index = from; index < to; index += 1) if (code[index] !== '\n') code[index] = ' ';
  };
  // Copies literal text into the sql view. An escape is read as a pair, so \\n is a backslash and an n; of
  // the pairs, \n, \t and \r become two spaces and every other one is copied as written.
  const keepText = (from, to) => {
    for (let index = from; index < to; index += 1) {
      if (raw[index] === '\\' && index + 1 < to) {
        const spaced = SQL_WHITE_SPACE_ESCAPES.has(raw[index + 1]);
        sql[index] = spaced ? ' ' : raw[index];
        sql[index + 1] = spaced ? ' ' : raw[index + 1];
        index += 1;
      } else {
        sql[index] = raw[index];
      }
    }
    blank(from, to);
  };
  const isLineTerminator = (char) => char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029';
  const isSpace = (char) => char === ' ' || char === '\t' || isLineTerminator(char);
  // The index of the last character that is not white space at or before `from`; -1 when there is none.
  const skipSpacesBack = (from) => {
    let cursor = from;
    while (cursor >= 0 && isSpace(code[cursor])) cursor -= 1;
    return cursor;
  };

  // Does the token that ends at `cursor` end an operand, so that a slash after it divides? A name, a
  // number, a closing bracket or a literal does. An operator, a bracket that opens and a keyword such
  // as return do not, except a keyword used as a property name (obj.in, obj?.of), which is a name.
  // A dot that closes `...` is a spread, not a property access: [...await /x/.exec(a)].
  function endsOperand(cursor) {
    const previous = code[cursor];
    if (previous === ')' || previous === ']' || previous === "'" || previous === '"' || previous === '`') return true;
    if (!WORD_CHARACTER.test(previous)) return false;
    let begin = cursor;
    while (begin > 0 && WORD_CHARACTER.test(code[begin - 1])) begin -= 1;
    if (!REGEX_AFTER_WORDS.has(code.slice(begin, cursor + 1).join(''))) return true;
    const dot = skipSpacesBack(begin - 1);
    return dot >= 0 && code[dot] === '.' && code[dot - 1] !== '.';
  }

  // Does a slash at `index` open a regular expression? It does after an operator, a bracket that opens,
  // a keyword such as return, or at the start; it divides after an operand. `a++ / b` divides: a ++ or
  // -- that follows an operand is a postfix operator, while one that follows an operator is a prefix
  // operator and leaves the slash to open an expression (`x = ++/a/.lastIndex`).
  function opensRegex(index) {
    const cursor = skipSpacesBack(index - 1);
    if (cursor < 0) return true;
    const previous = code[cursor];
    if ((previous === '+' || previous === '-') && code[cursor - 1] === previous) {
      const operand = skipSpacesBack(cursor - 2);
      return operand < 0 || !endsOperand(operand);
    }
    return !endsOperand(cursor);
  }

  function regexEnd(start) {
    let inClass = false;
    for (let index = start + 1; index < length; index += 1) {
      const char = raw[index];
      if (isLineTerminator(char)) return -1;
      if (char === '\\') index += 1;
      else if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) {
        let end = index + 1;
        while (end < length && /[A-Za-z]/u.test(raw[end])) end += 1;
        return end;
      }
    }
    return -1;
  }

  function scanString(start) {
    const quote = raw[start];
    let index = start + 1;
    while (index < length) {
      const char = raw[index];
      if (char === '\\') {
        index += 2;
      } else if (char === quote) {
        literals.set(start, { end: index, quote, value: raw.slice(start + 1, index), dynamic: false });
        keepText(start + 1, index);
        return index + 1;
      } else if (char === '\n' || char === '\r') {
        break;
      } else {
        index += 1;
      }
    }
    fail('a string that never closes', start);
    return Math.min(index, length);
  }

  function scanTemplate(start) {
    const ranges = [];
    let from = start + 1;
    let index = from;
    while (index < length) {
      const char = raw[index];
      if (char === '\\') {
        index += 2;
      } else if (char === '`') {
        ranges.push([from, index]);
        literals.set(start, {
          end: index,
          quote: '`',
          value: ranges.map(([begin, end]) => raw.slice(begin, end)).join('\u0001'),
          dynamic: ranges.length > 1,
        });
        for (const [begin, end] of ranges) keepText(begin, end);
        return index + 1;
      } else if (char === '$' && raw[index + 1] === '{') {
        ranges.push([from, index]);
        index = scanCode(index + 2, true);
        from = index;
      } else {
        index += 1;
      }
    }
    fail('a template literal that never closes', start);
    return length;
  }

  // Scans code from `from`; inside a template placeholder it stops after the closing brace.
  function scanCode(from, inPlaceholder) {
    let index = from;
    let depth = 0;
    while (index < length) {
      const char = raw[index];
      const next = raw[index + 1];
      if (char === '/' && next === '/') {
        // A line comment ends before the first line terminator, which is \n, \r, U+2028 or U+2029;
        // what follows on the next line is code.
        let stop = index + 2;
        while (stop < length && !isLineTerminator(raw[stop])) stop += 1;
        blank(index, stop);
        index = stop;
      } else if (char === '/' && next === '*') {
        const end = raw.indexOf('*/', index + 2);
        if (end < 0) {
          fail('a comment that never closes', index);
          blank(index, length);
          return length;
        }
        blank(index, end + 2);
        index = end + 2;
      } else if (char === "'" || char === '"') {
        index = scanString(index);
      } else if (char === '`') {
        index = scanTemplate(index);
      } else if (char === '/') {
        const end = opensRegex(index) ? regexEnd(index) : -1;
        if (end > index) {
          blank(index, end);
          index = end;
        } else {
          index += 1;
        }
      } else {
        if (char === '{') {
          depth += 1;
        } else if (char === '}') {
          if (inPlaceholder && depth === 0) return index + 1;
          depth = Math.max(0, depth - 1);
        }
        index += 1;
      }
    }
    if (inPlaceholder) fail('a template placeholder that never closes', from);
    return length;
  }

  let start = 0;
  if (raw.startsWith('#!')) {
    const end = raw.indexOf('\n');
    start = end < 0 ? length : end;
    blank(0, start);
  }
  scanCode(start, false);
  const ordered = [...literals].sort((left, right) => left[0] - right[0]);
  return { raw, code: code.join(''), sql: sql.join(''), literals, ordered, problem, lineOf };
}

function nextNonSpace(text, from) {
  let index = from;
  while (index < text.length && /\s/u.test(text[index])) index += 1;
  return index;
}

// The loads in one scanned file: [{ request, offset }] for every require( or import( call with one
// relative literal, and every `from` with one.
function loadsIn(scan) {
  const found = [];
  const consider = (match, needsClosingParenthesis) => {
    const offset = match.index + match[0].length - 1;
    const literal = scan.literals.get(offset);
    if (!literal || literal.dynamic || !/^\.{1,2}\/./u.test(literal.value)) return;
    if (needsClosingParenthesis && scan.code[nextNonSpace(scan.code, literal.end + 1)] !== ')') return;
    found.push({ request: literal.value, offset });
  };
  for (const match of scan.code.matchAll(CALL_LOAD_PATTERN)) consider(match, true);
  for (const match of scan.code.matchAll(FROM_LOAD_PATTERN)) consider(match, false);
  return found;
}

function createLineLocator(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

function createProject(rootInput) {
  const root = path.resolve(rootInput);
  const sources = new Map();
  const loads = new Map();
  const problems = new Map();

  function exists(relativePath) {
    try {
      return fs.statSync(path.join(root, relativePath)).isFile();
    } catch {
      return false;
    }
  }

  function readSource(file) {
    if (!sources.has(file)) {
      const scan = scanSource(fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/gu, '\n'));
      if (scan.problem) problems.set(file, scan.problem);
      sources.set(file, scan);
    }
    return sources.get(file);
  }

  // Resolves a relative require the way scripts/check-project.js does; null when it leaves the project
  // or names nothing that exists.
  function resolveLocal(file, request) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), request));
    if (base.startsWith('../') || base === '..') return null;
    const candidates = [base, `${base}.js`, `${base}.json`, `${base}/index.js`];
    return candidates.find(exists) || null;
  }

  function loadsOf(file) {
    if (!loads.has(file)) {
      const scan = readSource(file);
      loads.set(file, loadsIn(scan).map(({ request, offset }) => ({
        request,
        target: resolveLocal(file, request),
        line: scan.lineOf(offset),
      })));
    }
    return loads.get(file);
  }

  const sourceFiles = listFiles(root, 'src').filter((file) => file.endsWith('.js'));
  const productionFiles = exists('deploy-commands.js') ? [...sourceFiles, 'deploy-commands.js'] : sourceFiles;
  return { root, exists, readSource, loadsOf, resolveLocal, sourceFiles, productionFiles, problems };
}

function createReport() {
  const violations = new Map();
  const errors = [];
  return {
    violations,
    errors,
    add(rule, file, target, line, message) {
      const key = `${rule}|${file}|${target}`;
      const known = violations.get(key) || { key, rule, file, target, count: 0, lines: [], message };
      known.count += 1;
      if (line && !known.lines.includes(line)) known.lines.push(line);
      violations.set(key, known);
    },
    error(message) {
      if (!errors.includes(message)) errors.push(message);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

function eachLoad(project, callback) {
  for (const file of project.productionFiles) {
    for (const load of project.loadsOf(file)) {
      if (load.target) callback(file, load);
    }
  }
}

function checkEntryStorage(project, report) {
  eachLoad(project, (file, load) => {
    if (isEntry(file) && STORAGE_ENGINES.has(load.target)) {
      report.add('R1', file, load.target, load.line, `loads the storage engine ${load.target}`);
    }
  });
}

function checkEntryOnlyLoadsEntry(project, report) {
  eachLoad(project, (file, load) => {
    if (!isEntry(file) && (isUnder(load.target, 'src/commands') || isUnder(load.target, 'src/events'))) {
      report.add('R2', file, load.target, load.line, `loads the Discord entry module ${load.target}`);
    }
  });
}

// A registered adapter is a file listed in ADAPTER_FILES or below an adapter root.
function isRegisteredAdapter(file) {
  return ADAPTER_FILES.includes(file) || ADAPTER_ROOTS.some((root) => isUnder(file, root));
}

// The file a registered adapter forwards to; null when `file` is not a registered adapter, is not written
// as a one-line forward, or forwards to nothing that exists.
function adapterForward(project, file) {
  if (!isRegisteredAdapter(file) || !project.exists(file)) return null;
  const request = adapterTarget(project.readSource(file).raw);
  return request === null ? null : project.resolveLocal(file, request);
}

function forwardsToCoordinator(project, file) {
  const forward = adapterForward(project, file);
  return forward !== null && isUnder(forward, 'src/coordinators');
}

function checkCoordinatorDirection(project, report) {
  eachLoad(project, (file, load) => {
    const fromSystemOrService = isUnder(file, 'src/systems') || isUnder(file, 'src/services');
    // One load is exempt: the forward of a registered one-line adapter, which keeps the old path of a
    // module that moved into src/coordinators working for outside callers. Any other load of such a file
    // is checked, an adapter that is no longer a one-line forward is not exempt at all, and R8 keeps
    // production code from loading the adapter, so no internal dependency runs through it.
    if (fromSystemOrService && isUnder(load.target, 'src/coordinators') && adapterForward(project, file) !== load.target) {
      report.add('R3', file, load.target, load.line, `loads the coordinator ${load.target}`);
    }
    if (isUnder(file, 'src/coordinators') && isEntry(load.target)) {
      report.add('R3', file, load.target, load.line, `loads the entry module ${load.target}`);
    }
  });
}

function checkEconomyIsolation(project, report) {
  eachLoad(project, (file, load) => {
    if (systemOf(file) !== 'economy') return;
    const targetSystem = systemOf(load.target);
    if (ECONOMY_FORBIDDEN_SYSTEMS.has(targetSystem)) {
      report.add('R4', file, load.target, load.line, `loads ${load.target}, which belongs to ${targetSystem}`);
    }
  });
}

function checkPlatformAndUtils(project, report) {
  eachLoad(project, (file, load) => {
    if (!isUnder(file, 'src/platform') && !isUnder(file, 'src/utils')) return;
    if (PLATFORM_EXCEPTIONS.has(file)) return;
    if (isUnder(load.target, 'src/systems') || isUnder(load.target, 'src/services') || isUnder(load.target, 'src/coordinators')) {
      report.add('R5', file, load.target, load.line, `loads ${load.target}`);
    }
  });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// The SQL statements and clauses that name a table. Keywords are upper case, as the code writes them, so
// that ordinary words in a message ("from identity") are not read as SQL.
const SQL_STATEMENT = new RegExp(`\\b(?:${[
  'FROM',
  'JOIN',
  'INTO',
  'UPDATE(?:\\s+OR\\s+(?:ABORT|FAIL|IGNORE|REPLACE|ROLLBACK))?',
  'ALTER\\s+TABLE',
  'RENAME\\s+TO',
  'DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?',
  'CREATE\\s+(?:VIRTUAL\\s+)?TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?',
  'CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?\\S+\\s+ON',
  'CREATE\\s+(?:TEMP\\s+|TEMPORARY\\s+)?TRIGGER\\b[^;\\u0001]*?\\bON',
].join('|')})\\b`, 'gu');
const SQL_NAME = /[A-Za-z_][A-Za-z0-9_]*/uy;
const SQL_ALIAS = /(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*)/iuy;
// Words that follow a table in a FROM list and are not its alias.
const SQL_CLAUSE_WORDS = new Set([
  'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW', 'JOIN', 'LEFT',
  'RIGHT', 'FULL', 'INNER', 'CROSS', 'NATURAL', 'OUTER', 'ON', 'USING', 'SET', 'VALUES', 'SELECT', 'INDEXED', 'NOT',
  'RETURNING',
]);

function skipSqlSpace(text, from) {
  let index = from;
  while (index < text.length && /\s/u.test(text[index])) index += 1;
  return index;
}

// One name, plain or quoted with "", `` or [] (a quote inside a JavaScript string is written \" or \`).
function readSqlName(text, from) {
  let index = from;
  let close = null;
  if (text[index] === '\\' && (text[index + 1] === '"' || text[index + 1] === '`')) {
    close = text[index + 1];
    index += 2;
  } else if (text[index] === '"' || text[index] === '`') {
    close = text[index];
    index += 1;
  } else if (text[index] === '[') {
    close = ']';
    index += 1;
  }
  SQL_NAME.lastIndex = index;
  const name = SQL_NAME.exec(text);
  if (!name) return null;
  index += name[0].length;
  if (close !== null) {
    if (close !== ']' && text[index] === '\\') index += 1;
    if (text[index] === close) index += 1;
  }
  return { name: name[0], end: index };
}

// A table name after a keyword, with an optional schema in front (main., temp., or an attached name).
function readTableReference(text, from) {
  const first = readSqlName(text, skipSqlSpace(text, from));
  if (!first) return null;
  if (text[first.end] === '.') {
    const second = readSqlName(text, first.end + 1);
    if (second) return second;
  }
  return first;
}

function skipSqlAlias(text, from) {
  const start = skipSqlSpace(text, from);
  SQL_ALIAS.lastIndex = start;
  const alias = SQL_ALIAS.exec(text);
  if (!alias || SQL_CLAUSE_WORDS.has(alias[1].toUpperCase())) return start;
  return skipSqlSpace(text, start + alias[0].length);
}

// Every table the SQL text names, as [{ name (lower case), offset, creates }]. After FROM the whole list
// is read: FROM a, b AS x, c y names three tables.
function sqlReferences(sql) {
  const references = [];
  for (const match of sql.matchAll(SQL_STATEMENT)) {
    const keyword = match[0];
    const first = readTableReference(sql, match.index + keyword.length);
    if (!first) continue;
    references.push({
      name: first.name.toLowerCase(),
      offset: match.index,
      creates: /^CREATE\s+(?:VIRTUAL\s+)?TABLE/u.test(keyword),
    });
    if (keyword !== 'FROM') continue;
    let end = skipSqlAlias(sql, first.end);
    while (sql[end] === ',') {
      const next = readTableReference(sql, end + 1);
      if (!next) break;
      references.push({ name: next.name.toLowerCase(), offset: match.index, creates: false });
      end = skipSqlAlias(sql, next.end);
    }
  }
  return references;
}

// A table is named by the files of its family only. A table that is created but belongs to no family
// has no owner at all, which is also reported, so every new table gets an owner when it is made.
function checkTableOwners(project, report) {
  const references = new Map();
  const created = new Map();
  for (const file of project.sourceFiles) {
    const found = sqlReferences(project.readSource(file).sql);
    references.set(file, found);
    for (const { name, creates } of found) {
      if (creates && !created.has(name)) created.set(name, file);
    }
  }
  for (const [table, file] of created) {
    if (!familyOf(table)) report.add('R6', file, `no-owner:${table}`, null, `creates table ${table}, which has no declared owner`);
  }
  for (const file of project.sourceFiles) {
    if (SCHEMA_OWNER_FILES.has(file)) continue;
    const { lineOf } = project.readSource(file);
    for (const { name, offset } of references.get(file)) {
      const family = created.has(name) ? familyOf(name) : null;
      if (!family || belongsTo(file, family.owners)) continue;
      report.add('R6', file, name, lineOf(offset), `names table ${name}, which belongs to ${family.name}`);
    }
  }
}

function documentedHooks(project) {
  if (!project.exists(CONTRACT_FILE)) return new Set();
  const text = fs.readFileSync(path.join(project.root, CONTRACT_FILE), 'utf8');
  return new Set([...text.matchAll(/\bhooks\.([A-Za-z][A-Za-z0-9_.]*[A-Za-z0-9_])/gu)].map((match) => match[1]));
}

// Where argument number `argumentIndex` of a call starts, `from` being the position after its opening
// parenthesis; -1 when the call has fewer arguments. Brackets inside an argument are skipped, and
// strings and comments are already blank in `code`.
function argumentStart(code, from, argumentIndex) {
  if (argumentIndex === 0) return from;
  let depth = 0;
  let seen = 0;
  for (let index = from; index < code.length; index += 1) {
    const char = code[index];
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) return -1;
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      seen += 1;
      if (seen === argumentIndex) return index + 1;
    }
  }
  return -1;
}

// The hook names a scanned file runs, once per place: runHook with a literal name, a forwarder with a
// literal name, and any literal that starts with a forwarder's prefix (a name handed to an injected runner).
function hookNamesIn(scan) {
  const found = new Map();
  const literalAt = (from) => {
    const offset = nextNonSpace(scan.code, from);
    const literal = scan.literals.get(offset);
    return literal && !literal.dynamic ? { offset, literal } : null;
  };
  for (const match of scan.code.matchAll(/\brunHook\s*\(/gu)) {
    const hit = literalAt(match.index + match[0].length);
    if (hit && /^[A-Za-z0-9_.]+$/u.test(hit.literal.value)) found.set(hit.offset, hit.literal.value);
  }
  for (const forwarder of HOOK_FORWARDERS) {
    for (const match of scan.code.matchAll(new RegExp(`\\b${escapeRegExp(forwarder.name)}\\s*\\(`, 'gu'))) {
      const start = argumentStart(scan.code, match.index + match[0].length, forwarder.argIndex);
      const hit = start < 0 ? null : literalAt(start);
      if (hit && /^[A-Za-z0-9_]+$/u.test(hit.literal.value)) found.set(hit.offset, `${forwarder.prefix}${hit.literal.value}`);
    }
    for (const [offset, literal] of scan.literals) {
      if (!literal.dynamic && literal.value.startsWith(forwarder.prefix)
          && /^[A-Za-z0-9_]+$/u.test(literal.value.slice(forwarder.prefix.length))) found.set(offset, literal.value);
    }
  }
  return [...found].map(([offset, name]) => ({ name, line: scan.lineOf(offset) }));
}

function checkHookContract(project, report) {
  const documented = documentedHooks(project);
  for (const file of project.productionFiles) {
    for (const { name, line } of hookNamesIn(project.readSource(file))) {
      if (!documented.has(name)) report.add('R7', file, name, line, `runs hook ${name}, which ${CONTRACT_FILE} does not list`);
    }
  }
}

function adapterTarget(raw) {
  const match = ONE_LINE_ADAPTER.exec(raw) || CLI_ADAPTER.exec(raw);
  return match ? match[1] : null;
}

function checkAdapters(project, report) {
  const registered = new Set(ADAPTER_FILES);
  for (const root of ADAPTER_ROOTS) {
    for (const file of listFiles(project.root, root)) {
      if (file.endsWith('.js')) registered.add(file);
    }
  }
  for (const file of [...registered].sort(byCodeUnit)) {
    // A registered adapter that was deleted has nothing left to check.
    if (!project.exists(file)) continue;
    const request = adapterTarget(project.readSource(file).raw);
    if (request === null) {
      report.add('R8', file, 'format', 1, 'is a registered adapter but is not a one-line forward to its implementation');
    } else if (!project.resolveLocal(file, request)) {
      report.add('R8', file, 'missing-target', 1, `forwards to ${request}, which does not exist`);
    }
  }
  eachLoad(project, (file, load) => {
    if (ADAPTER_ROOTS.some((root) => isUnder(file, root))) return;
    if (ADAPTER_ROOTS.some((root) => isUnder(load.target, root))) {
      report.add('R8', file, load.target, load.line, `loads the legacy adapter ${load.target}; load the implementation under src/systems instead`);
    } else if (forwardsToCoordinator(project, load.target)) {
      report.add('R8', file, load.target, load.line, `loads the adapter ${load.target}, which only forwards to a coordinator; load the coordinator instead`);
    }
  });
}

function checkFrozenServices(project, report) {
  for (const file of listFiles(project.root, FROZEN_DIRECTORY)) {
    report.add('R9', file, FROZEN_DIRECTORY, null, `is a file in ${FROZEN_DIRECTORY}, which accepts no new files`);
  }
}

// Does the code of a scanned file name tools/live-test? Comments do not count, and neither does prose.
function namesPrivateTool(scan) {
  for (const [, literal] of scan.literals) {
    if (PRIVATE_TOOL_PATH_LITERAL.test(literal.value)) return true;
  }
  for (let index = 0; index + 1 < scan.ordered.length; index += 1) {
    const [, first] = scan.ordered[index];
    const [secondOffset, second] = scan.ordered[index + 1];
    if (first.value === 'tools' && second.value === 'live-test'
        && /^\s*,\s*$/u.test(scan.code.slice(first.end + 1, secondOffset))) return true;
  }
  return false;
}

function isPrivateToolTest(project, file) {
  return PRIVATE_TOOL_TEST_PATH.test(file) && namesPrivateTool(project.readSource(file));
}

function checkExport(project, report) {
  let exported = null;
  try {
    exported = new Set(buildPublicExportPlan({
      sourceRoot: project.root,
      manifestPath: path.join(project.root, MANIFEST_FILE),
    }));
  } catch (error) {
    report.error(`R10 the public export plan could not be built: ${error.message}`);
  }
  // Files git ignores and does not track (runtime data, local build output) are not part of the project;
  // the export leaves them out too. Without a git work tree only RUNTIME_DATA_PATH applies.
  let ignored = null;
  try {
    ignored = listIgnoredUntracked(project.root);
  } catch (error) {
    report.error(`R10 the public export plan could not be built: ${error.message}`);
  }
  for (const directory of EXPORT_CHECKED_DIRECTORIES) {
    for (const file of listFiles(project.root, directory)) {
      if (IGNORED_FILE_NAMES.has(path.posix.basename(file))) continue;
      // Runtime data in src/data is not part of the project (see RUNTIME_DATA_PATH). Code there is not
      // data: git ignores all of src/data, yet a script in it is still refused.
      if (RUNTIME_DATA_PATH.test(file)) continue;
      if (!isUnder(file, 'src/data') && isIgnoredUntracked(file, ignored)) continue;
      // Exempt tests of the private live-test tools skip both checks below (see PRIVATE_TOOL_TEST_PATH).
      if (isPrivateToolTest(project, file)) continue;
      try {
        assertAllowedPath(file);
      } catch (error) {
        report.add('R10', file, 'protected-path', null, `has a path the public export refuses (${error.message})`);
      }
      if (exported && !exported.has(file)) {
        report.add('R10', file, 'not-exported', null, 'is not in the public export');
      }
    }
  }
  // Exported code outside test runs in the public copy, which has no tools/live-test, so it must not name it
  // (namesPrivateTool: a path through it, or 'tools' and 'live-test' as consecutive arguments). A private tool
  // hands such a path to public code from its own code instead.
  for (const file of exported || []) {
    if (isUnder(file, 'test') || !EXPORTED_CODE.test(file) || !project.exists(file)) continue;
    if (namesPrivateTool(project.readSource(file))) {
      report.add('R10', file, 'private-tool-path', null, 'names the private tools/live-test, which the public export leaves out');
    }
  }
}

const RULE_CHECKS = Object.freeze({
  R1: checkEntryStorage,
  R2: checkEntryOnlyLoadsEntry,
  R3: checkCoordinatorDirection,
  R4: checkEconomyIsolation,
  R5: checkPlatformAndUtils,
  R6: checkTableOwners,
  R7: checkHookContract,
  R8: checkAdapters,
  R9: checkFrozenServices,
  R10: checkExport,
});

// Runs the rules against the project at `root`. Returns the violations, grouped by rule, file and
// target, and any problem that stopped a rule from running.
function collectViolations({ root = PROJECT_ROOT, rules = Object.keys(RULES) } = {}) {
  for (const rule of rules) {
    if (!RULE_CHECKS[rule]) throw new Error(`Unknown boundary rule: ${rule}`);
  }
  const project = createProject(root);
  const report = createReport();
  for (const rule of rules) RULE_CHECKS[rule](project, report);
  for (const [file, problem] of project.problems) report.error(`${file} could not be read reliably: ${problem}`);
  return { violations: report.violations, errors: report.errors };
}

// ---------------------------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------------------------

function entryKey(entry) {
  return `${entry.rule}|${entry.file}|${entry.target}`;
}

function validateEntry(entry, position) {
  const problems = [];
  const label = `entry ${position + 1}${entry && typeof entry.id === 'string' ? ` (${entry.id})` : ''}`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [`${label} is not an object`];
  for (const field of Object.keys(entry)) {
    if (!BASELINE_FIELDS.has(field)) problems.push(`${label} has the unknown field "${field}"`);
  }
  if (typeof entry.rule !== 'string' || !RULES[entry.rule]) problems.push(`${label} has an unknown rule`);
  if (typeof entry.id !== 'string' || !/^R(?:10|[1-9])-\d{3}$/u.test(entry.id) || entry.id.split('-')[0] !== entry.rule) {
    problems.push(`${label} needs an id like R6-001 that starts with its rule`);
  }
  if (typeof entry.file !== 'string' || !entry.file || entry.file.includes('\\') || entry.file.startsWith('/')
      || entry.file.split('/').includes('..')) {
    problems.push(`${label} needs a relative, slash-separated file`);
  }
  if (typeof entry.target !== 'string' || !entry.target) problems.push(`${label} needs a target`);
  if (!Number.isInteger(entry.count) || entry.count < 1) problems.push(`${label} needs a count of at least 1`);
  if (typeof entry.disposition !== 'string' || !DISPOSITION_PATTERN.test(entry.disposition)) {
    problems.push(`${label} needs a disposition such as cleanup, pending-decision or unscheduled`);
  }
  if (entry.note !== undefined && (typeof entry.note !== 'string' || !entry.note)) problems.push(`${label} has an empty note`);
  return problems;
}

function loadBaseline(baselinePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    throw new Error(`The boundary baseline ${baselinePath} could not be read: ${error.message}`);
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`The boundary baseline ${baselinePath} must be an object with version 1 and an entries array.`);
  }
  const problems = parsed.entries.flatMap(validateEntry);
  const ids = new Set();
  const keys = new Set();
  for (const entry of parsed.entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (ids.has(entry.id)) problems.push(`the id ${entry.id} appears twice`);
    ids.add(entry.id);
    if (keys.has(entryKey(entry))) problems.push(`${entry.id} repeats ${entry.rule} ${entry.file} -> ${entry.target}`);
    keys.add(entryKey(entry));
  }
  if (problems.length) throw new Error(`The boundary baseline ${baselinePath} is not valid:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  return parsed.entries;
}

function where(violation) {
  const lines = violation.lines.slice(0, 5).join(',');
  return lines ? `${violation.file}:${lines}` : violation.file;
}

function compareWithBaseline(violations, entries, rules) {
  const failures = [];
  const recorded = new Map(entries.filter((entry) => rules.includes(entry.rule)).map((entry) => [entryKey(entry), entry]));
  for (const violation of violations.values()) {
    const entry = recorded.get(violation.key);
    const times = violation.count === 1 ? '1 time' : `${violation.count} times`;
    if (!entry) {
      failures.push(`${violation.rule} new violation: ${where(violation)} ${violation.message} (${times}). Fix the code; the baseline only shrinks.`);
    } else if (violation.count > entry.count) {
      failures.push(`${violation.rule} ${entry.id} grew: ${where(violation)} ${violation.message} (${times}; the baseline records ${entry.count}). Fix the new use.`);
    } else if (violation.count < entry.count) {
      failures.push(`${violation.rule} ${entry.id} shrank: ${violation.file} -> ${violation.target} occurs ${times}; the baseline records ${entry.count}. Lower its count in ${BASELINE_FILE}.`);
    }
  }
  for (const [key, entry] of recorded) {
    if (!violations.has(key)) {
      failures.push(`${entry.rule} ${entry.id} is stale: ${entry.file} -> ${entry.target} no longer violates the rule. Delete the entry from ${BASELINE_FILE}.`);
    }
  }
  return failures;
}

// Runs the rules and compares them with the baseline. `failures` is empty when the project is clean
// apart from the recorded exceptions. `entries` is null when the baseline could not be loaded.
function evaluateBoundaries({ root = PROJECT_ROOT, baselinePath, rules = Object.keys(RULES) } = {}) {
  const resolvedBaseline = baselinePath || path.join(path.resolve(root), BASELINE_FILE);
  const { violations, errors } = collectViolations({ root, rules });
  const failures = [...errors];
  let entries;
  try {
    entries = loadBaseline(resolvedBaseline);
  } catch (error) {
    failures.push(error.message);
    return { failures, violations, entries: null };
  }
  failures.push(...compareWithBaseline(violations, entries, rules));
  return { failures, violations, entries };
}

function findBoundaryFailures({ projectRoot = PROJECT_ROOT, baselinePath, rules } = {}) {
  return evaluateBoundaries({ root: projectRoot, baselinePath, rules }).failures;
}

// ---------------------------------------------------------------------------------------------
// Report and command line
// ---------------------------------------------------------------------------------------------

function tally(entries, field) {
  const counts = new Map();
  for (const entry of entries) counts.set(entry[field], (counts.get(entry[field]) || 0) + 1);
  return counts;
}

function naturalOrder(left, right) {
  return left.length - right.length || byCodeUnit(left, right);
}

function formatReport(entries) {
  const lines = [`Boundary baseline: ${entries.length} recorded exceptions.`];
  const byRule = tally(entries, 'rule');
  lines.push('By rule:');
  for (const rule of Object.keys(RULES)) lines.push(`  ${rule}: ${byRule.get(rule) || 0}`);
  const byDisposition = tally(entries, 'disposition');
  lines.push('By expected resolution:');
  for (const disposition of [...byDisposition.keys()].sort(naturalOrder)) {
    const perRule = tally(entries.filter((entry) => entry.disposition === disposition), 'rule');
    const detail = Object.keys(RULES).filter((rule) => perRule.has(rule)).map((rule) => `${rule}: ${perRule.get(rule)}`);
    lines.push(`  ${disposition}: ${byDisposition.get(disposition)} (${detail.join(', ')})`);
  }
  return lines.join('\n');
}

function parseArguments(argv) {
  const options = { report: false, root: PROJECT_ROOT, baselinePath: undefined, rules: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${argument} needs a value`);
      return argv[index];
    };
    if (argument === '--report') options.report = true;
    else if (argument === '--root') options.root = path.resolve(value());
    else if (argument === '--baseline') options.baselinePath = path.resolve(value());
    else if (argument === '--rule') options.rules = [...(options.rules || []), value()];
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function main(argv) {
  const options = parseArguments(argv);
  const { failures, entries } = evaluateBoundaries(options);
  if (options.report && entries) console.log(formatReport(entries));
  if (failures.length) {
    console.error(`Boundary check failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
    return 1;
  }
  const ruleCount = (options.rules || Object.keys(RULES)).length;
  console.log(`Boundary check passed: ${ruleCount} ${ruleCount === 1 ? 'rule' : 'rules'}, ${entries.length} recorded exceptions.`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

// TABLE_FAMILIES, createProject, familyOf, sqlReferences and systemOf are exported for
// scripts/architecture-facts.js, which recounts what docs/ARCHITECTURE.md cites.
module.exports = {
  ADAPTER_FILES,
  RULES,
  TABLE_FAMILIES,
  collectViolations,
  createProject,
  evaluateBoundaries,
  familyOf,
  findBoundaryFailures,
  formatReport,
  loadBaseline,
  loadsIn,
  scanSource,
  sqlReferences,
  systemOf,
};
