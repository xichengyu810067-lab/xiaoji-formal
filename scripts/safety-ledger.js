#!/usr/bin/env node

'use strict';

/*
 * Operator tool for the side-effect ledgers (npm run safety:ledger -- <command>).
 *
 *   status              Read-only report of every purpose: its coin database registration,
 *                       ledger files, staged files, the three quarantine places, pending
 *                       requests, the receipt digest, and a store inspection (integrity,
 *                       row digests, schema, both witness slots, continuity, lastSeen,
 *                       whether the ledger was ever used, and whether a WAL is present).
 *                       Nothing is booted, recovered, pruned, or written. A ledger held by
 *                       the running bot is reported as in-use and not opened further.
 *                       Limitation: closing a ledger that a crash left with a WAL
 *                       checkpoints it into the database file (a physical write; the
 *                       logical content is unchanged).
 *                       It also probes whether the data folders sync a directory (the
 *                       coin database's folder, and the ledger and witness folders when
 *                       they exist and are other folders): each is opened read-only,
 *                       fsynced and closed, nothing written. One line with a fixed code,
 *                       never a path: DIRECTORY_SYNC_OK, DIRECTORY_SYNC_UNSUPPORTED (the
 *                       coin database's folder cannot sync a directory: the coin database
 *                       still writes there as a best effort, but the safety ledgers need
 *                       a directory sync, so every protected effect would be turned off at
 *                       the start), DIRECTORY_SYNC_FAILED, or DIRECTORY_SYNC_NOT_APPLICABLE
 *                       (Windows). Unsupported and failed both need attention: do not
 *                       start.
 *                       Exit code 0 when nothing needs attention, 2 otherwise.
 *   reinit              --purpose <id> (repeatable) or --all, --bot-stopped, and one
 *                       --confirm <purpose>=<8-character code> per purpose (the code is
 *                       printed by status). The bot must be stopped first; --bot-stopped
 *                       states that it is and is the real safeguard: a ledger the bot has
 *                       open is refused (its lock is taken), but a creation still in
 *                       progress is not detected. (On Windows a file the bot still holds
 *                       cannot be moved, so the run fails before writing that purpose's
 *                       request.) The final and staged files are moved into
 *                       retired-* directories with a manifest (never deleted) and
 *                       reinit-<stem>.request.json is written. The coin database is not
 *                       written: the bot verifies the request at its next start, retires
 *                       the registration, and creates a new ledger with a new genesis and
 *                       cutover. The registered ledger may be active or still creating
 *                       (code from its registration), unregistered or with an unparsable
 *                       registration (code from the ledger ID inside the database; the
 *                       clock must be past that registration's last write, since the bot
 *                       only accepts a request written after it).
 *   release-quarantine  Same arguments, and the bot must be stopped too. Moves the
 *                       quarantine marker and stamp into a retired-* directory and writes
 *                       a release request; the bot clears the registration flag at its
 *                       next start after checking it.
 *   reset-start-failures
 *                       --bot-stopped only. Sets the count of the Owner DM start guard
 *                       (src/systems/safety/ownerDmStartGuard.js) back to 0, so the next start
 *                       sends Owner DMs again. The bot must be stopped: a running start that
 *                       is stopped by signal writes its own count back. An absent count is
 *                       left absent; a name taken by anything but a regular file is refused.
 *                       Not for a test-control data root, where the guard is never used.
 *
 * status also shows that count: the starts that failed in a row, and whether the next start
 * will send no Owner DM (3 or more, or a count that cannot be read or trusted; that needs
 * attention, exit code 2).
 *
 * status flags the Owner ledger (anomaly, exit code 2) when its DM channel preparation reached
 * Discord and ended rejected or unknown: owner-dm-preparation-rejected / -unknown. No Owner
 * notice can go out until that ledger is reinitialized (reinit --purpose owner-safety).
 *
 * Requests are written as <name>.tmp, fsynced, and renamed, so an interrupted write never
 * leaves half a request. A leftover .tmp is ignored by the bot, shown by status, and
 * replaced by the next request written for that purpose.
 *
 * After restoring a backup of the whole data folder (ledgers, witnesses, and the coin
 * database together, which cannot be detected), run status and then reinit.
 *
 * Paths: --data-root <dir> (default XIAOJI_DATA_ROOT, else the coin database's folder) and
 * --coin-db <file> (default COIN_DB_PATH). A data root carrying the test-control marker
 * is inspected with the test-control layout. --json prints the status report as JSON.
 */

const fs = require('node:fs');
const path = require('node:path');
const { getCoinDatabasePath, inspectSafetyRegistrationsFromFile, probeDirectorySync } = require('../src/services/coinDatabase');
const { TEST_DATA_ROOT_MARKER } = require('../src/platform/testControlPolicy');
const { inspectLedgerStore } = require('../src/systems/safety/ledgerStore');
const { describePurposeFiles } = require('../src/systems/safety/ledgerBootstrap');
const layout = require('../src/systems/safety/ledgerLayout');
const { inspectOwnerDmStartGuard, resetOwnerDmStartGuard } = require('../src/systems/safety/ownerDmStartGuard');
const { DM_PREPARATION_ACTION } = require('../src/systems/safety/ownerSafetyNotifier');
const { OWNER_PURPOSE_ID } = require('../src/systems/safety/sideEffectLedger');

const COMMANDS = new Set(['status', 'reinit', 'release-quarantine', 'reset-start-failures']);
const CONFIRMATION = /^([A-Za-z0-9._-]{1,64})=([a-f0-9]{8})$/u;

class UsageError extends Error {}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) {
    throw new UsageError('用法：safety-ledger.js status | reinit | release-quarantine | reset-start-failures [選項]\n' +
      'reinit、release-quarantine 與 reset-start-failures 必須先停止機器人，並加上 --bot-stopped。');
  }
  const options = { command, purposes: [], all: false, botStopped: false, confirms: new Map(), dataRoot: null,
    coinDb: null, json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = () => {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} 需要一個值。`);
      index += 1;
      return next;
    };
    if (flag === '--purpose') options.purposes.push(value());
    else if (flag === '--all') options.all = true;
    else if (flag === '--bot-stopped') options.botStopped = true;
    else if (flag === '--confirm') {
      const match = CONFIRMATION.exec(value());
      if (!match) throw new UsageError('--confirm 格式為 <purpose>=<8 碼確認碼>。');
      options.confirms.set(match[1], match[2]);
    } else if (flag === '--data-root') options.dataRoot = value();
    else if (flag === '--coin-db') options.coinDb = value();
    else if (flag === '--json') options.json = true;
    else throw new UsageError(`未知的參數：${flag}`);
  }
  for (const purposeId of options.purposes) {
    if (!layout.SAFETY_LEDGER_PURPOSES[purposeId]) throw new UsageError(`未知的用途：${purposeId}`);
  }
  if (options.command === 'reset-start-failures') {
    if (options.all || options.purposes.length || options.confirms.size || options.json) {
      throw new UsageError('reset-start-failures 只接受 --bot-stopped、--data-root 與 --coin-db。');
    }
    if (!options.botStopped) throw new UsageError('必須先停止機器人，並加上 --bot-stopped。');
  } else if (options.command !== 'status') {
    if (options.all === (options.purposes.length > 0)) throw new UsageError('請指定 --purpose（可重複）或 --all 其中一種。');
    if (!options.botStopped) throw new UsageError('必須先停止機器人，並加上 --bot-stopped。');
  }
  return options;
}

function resolvePaths(options, env) {
  const coinDbPath = options.coinDb || String(env.COIN_DB_PATH || '').trim() || getCoinDatabasePath();
  if (!path.isAbsolute(coinDbPath)) throw new UsageError('吉幣資料庫路徑必須是絕對路徑（--coin-db 或 COIN_DB_PATH）。');
  const base = options.dataRoot || String(env.XIAOJI_DATA_ROOT || '').trim() || path.dirname(coinDbPath);
  if (!path.isAbsolute(base)) throw new UsageError('資料根必須是絕對路徑（--data-root 或 XIAOJI_DATA_ROOT）。');
  const resolvedBase = path.resolve(base);
  let testRoot = false;
  try {
    fs.lstatSync(path.join(resolvedBase, TEST_DATA_ROOT_MARKER));
    testRoot = true;
  } catch {}
  const runtimeMode = testRoot ? 'test-control' : 'production';
  const directories = layout.resolveLedgerDirectories({
    env: { ...env, XIAOJI_DATA_ROOT: resolvedBase },
    runtimeMode,
    policy: { dataRoot: resolvedBase },
    coinDbPath,
  });
  return { coinDbPath: path.resolve(coinDbPath), directories, runtimeMode };
}

async function readRegistrations(coinDbPath) {
  try {
    const inspected = await inspectSafetyRegistrationsFromFile(coinDbPath);
    return { available: true, registrations: inspected.registrations, schemaVersion: inspected.schemaVersion };
  } catch {
    return { available: false, registrations: {}, schemaVersion: null };
  }
}

function registeredIdentityProblem(registration, identity) {
  if (identity.ledgerId !== registration.ledgerId) return 'ledger-id';
  if (identity.kind !== registration.kind) return 'kind';
  if (identity.runtimeMode !== registration.runtimeMode) return 'runtime-mode';
  if (identity.botId !== registration.botId) return 'bot';
  if (identity.ownerId !== registration.ownerId) return 'owner';
  if (identity.genesisMs !== registration.genesisMs) return 'genesis';
  if (identity.cutoverMs !== registration.cutoverMs) return 'cutover';
  return null;
}

// The Owner DM channel preparation reached Discord and ended rejected or unknown (or was cut off
// in flight, which the next start records as unknown). A durable outcome is never tried again, so
// every Owner notice of this ledger is dropped, across restarts, until the Owner ledger is
// reinitialized.
function ownerPreparationProblems(store) {
  const states = store?.rows?.byAction?.[DM_PREPARATION_ACTION] || {};
  return [
    ...(states.unknown || states.attempted ? ['owner-dm-preparation-unknown'] : []),
    ...(states.rejected ? ['owner-dm-preparation-rejected'] : []),
  ];
}

// One purpose's status: plain data, never a write.
function inspectPurpose(directories, purposeId, registrationEntry) {
  const described = describePurposeFiles(directories, purposeId, registrationEntry);
  const { paths, registration, files } = described;
  const anomalies = [];
  const staged = Object.entries(files.staged).filter(([, present]) => present).map(([role]) => role);
  const finalFiles = Object.entries(files.final).filter(([, present]) => present).map(([role]) => role);
  const quarantine = { marker: files.marker, stamp: files.stamp, registration: Boolean(registration?.quarantine) };
  if (described.registrationProblem) anomalies.push('registration-invalid');
  if (quarantine.marker || quarantine.stamp || quarantine.registration) anomalies.push('quarantined');
  let store = null;
  if (files.final.database) {
    store = inspectLedgerStore({
      filePath: paths.database,
      witnessPaths: [paths.anchor, paths.witness],
      notBefore: registration?.state === 'active' && registration.lastSeen ? registration.lastSeen : undefined,
    });
  }
  const state = described.registrationProblem ? 'invalid' : (registration?.state || 'none');
  let verdict = 'ok';
  if (store?.inUse) {
    verdict = 'in-use';
  } else {
    if (state === 'none' || state === 'retired') {
      if (finalFiles.length) anomalies.push('registration-missing');
      if (staged.length) anomalies.push('staged-files');
    } else if (registration) {
      const pathRole = layout.registeredPathMismatch(registration, paths);
      if (pathRole) anomalies.push(`path-mismatch-${pathRole}`);
      if (state === 'active') {
        const required = ['database', 'anchor', 'witness', 'receipt'].filter((role) => files.final[role]);
        if (!required.length) anomalies.push('files-missing');
        else if (required.length < 4) anomalies.push('partial');
        if (staged.length) anomalies.push('staged-files');
        if (files.final.receipt && described.receiptSha256 !== registration.receiptSha256) anomalies.push('receipt-mismatch');
      }
      if (store?.identity) {
        const problem = registeredIdentityProblem(registration, store.identity);
        if (problem) anomalies.push(`identity-${problem}`);
      }
    }
    if (store) anomalies.push(...store.problems.filter((problem) => problem !== 'in-use'));
    if (purposeId === OWNER_PURPOSE_ID) anomalies.push(...ownerPreparationProblems(store));
    if (anomalies.length) verdict = 'anomaly';
    else if (state === 'creating') verdict = 'pending';
    else if (state === 'none' && !finalFiles.length) verdict = 'absent';
  }
  // The ID a reinit is confirmed against: the registration's, or, when the registration is
  // missing or unparsable, the one the database itself carries.
  const ledgerId = registration?.ledgerId || store?.identity?.ledgerId || null;
  return Object.freeze({
    purposeId,
    verdict,
    registration: state,
    ledgerId,
    ledgerIdSource: registration?.ledgerId ? 'registration' : ledgerId ? 'database' : null,
    confirmationCode: ledgerId ? layout.confirmationCode(ledgerId) : null,
    runtimeMode: registration?.runtimeMode || store?.identity?.runtimeMode || null,
    cutoverMs: registration?.cutoverMs ?? store?.identity?.cutoverMs ?? null,
    lastSeen: registration?.lastSeen || null,
    files: finalFiles,
    staged,
    walPresent: files.final.wal,
    quarantine,
    // incomplete: a leftover <request>.tmp from an interrupted run; ignored by the bot.
    requests: { reinit: files.reinitRequest, releaseQuarantine: files.releaseRequest, incomplete: files.requestTemp },
    receipt: !files.final.receipt ? 'missing'
      : registration?.receiptSha256 ? (described.receiptSha256 === registration.receiptSha256 ? 'ok' : 'mismatch') : 'unregistered',
    store: store ? {
      inUse: store.inUse,
      header: store.header,
      schema: store.schema,
      integrity: store.integrity,
      neverUsed: store.neverUsed,
      neverOpened: store.neverOpened,
      rows: store.rows,
      registration: store.registration,
      counters: store.identity ? { bootEpoch: store.identity.bootEpoch, beginSeq: store.identity.beginSeq } : null,
      witnesses: store.witnesses.map((witness) => ({ name: path.basename(witness.filePath), present: witness.present,
        problem: witness.problem, tornSlots: witness.tornSlots, continuity: witness.continuity })),
    } : null,
    anomalies: [...new Set(anomalies)],
  });
}

const DIRECTORY_SYNC_CODES = Object.freeze({
  ok: 'DIRECTORY_SYNC_OK',
  unsupported: 'DIRECTORY_SYNC_UNSUPPORTED',
  failed: 'DIRECTORY_SYNC_FAILED',
  'not-applicable': 'DIRECTORY_SYNC_NOT_APPLICABLE',
});

// The data folders' directory sync: the coin database's folder, then the ledger and witness
// folders when they exist and are other folders (before the first start they do not exist
// yet). The coin database's folder is judged as its writes judge it, so a file system that
// cannot sync a directory is 'unsupported'; the ledger and witness folders are judged by the
// safety ledgers' rule, which fails on any directory sync error, so there it is 'failed'.
// Both need attention: the ledgers also sync the coin database's folder when they create their
// own folders, and fail there too. The worst result is reported, with its folder (coin-database,
// ledger or witness) and errno; never a path. A missing coin database folder is ENOENT.
function probeDataFolders(coinDbPath, directories, probe) {
  const folders = [['coin-database', path.dirname(coinDbPath)], ['ledger', directories.ledgerDirectory],
    ['witness', directories.witnessDirectory]];
  const seen = new Set();
  const results = [];
  for (const [folder, directory] of folders) {
    const resolved = path.resolve(directory);
    if (seen.has(resolved) || (folder !== 'coin-database' && !fs.existsSync(resolved))) continue;
    seen.add(resolved);
    const probed = probe(resolved);
    const result = folder !== 'coin-database' && probed.result === 'unsupported' ? 'failed' : probed.result;
    results.push({ folder, result, errno: probed.errno });
  }
  const worst = ['failed', 'unsupported', 'not-applicable', 'ok']
    .map((result) => results.find((item) => item.result === result)).find(Boolean);
  const reported = ['failed', 'unsupported'].includes(worst.result);
  return Object.freeze({ code: DIRECTORY_SYNC_CODES[worst.result], result: worst.result,
    errno: reported ? worst.errno : null, folder: reported ? worst.folder : null });
}

function formatDirectorySync(directorySync) {
  return `code=${directorySync.code}` +
    `${directorySync.errno ? ` errno=${directorySync.errno} folder=${directorySync.folder}` : ''}`;
}

// The Owner DM start guard's count, as the next start will find it.
function formatStartGuard(guard) {
  const prefix = 'Owner 私訊啟動保護：';
  if (guard.state === 'not-applicable') return `${prefix}test-control 不使用`;
  const next = guard.suppressNextStart ? '下次啟動不送 Owner 私訊，直到該次啟動成功或執行 reset-start-failures'
    : '下次啟動照常送 Owner 私訊';
  if (guard.state === 'invalid' || guard.state === 'unreadable') {
    return `${prefix}state=${guard.state}${guard.cause ? ` cause=${guard.cause}` : ''}（紀錄無法使用；${next}）`;
  }
  return `${prefix}連續啟動失敗 ${guard.consecutiveFailures} 次（門檻 ${guard.threshold}）；${next}`;
}

function formatStatus(report) {
  const lines = [
    `安全帳本狀態（${report.runtimeMode}）`,
    `帳本目錄：${report.directories.ledgerDirectory}`,
    `witness 目錄：${report.directories.witnessDirectory}`,
    `吉幣資料庫登記：${report.registrationsAvailable ? '可讀取' : '無法讀取'}`,
    `資料夾同步：${formatDirectorySync(report.directorySync)}`,
    formatStartGuard(report.ownerDmStartGuard),
  ];
  for (const item of report.purposes) {
    lines.push(`- ${item.purposeId}: ${item.verdict} registration=${item.registration}` +
      ` code=${item.confirmationCode || '-'} receipt=${item.receipt}` +
      `${item.store ? ` integrity=${item.store.integrity || '-'} neverUsed=${item.store.neverUsed}` : ''}` +
      `${item.walPresent ? ' wal=present' : ''}` +
      `${item.anomalies.length ? ` anomalies=${item.anomalies.join(',')}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

async function runStatus(options, env, io, probe) {
  const { coinDbPath, directories, runtimeMode } = resolvePaths(options, env);
  const { available, registrations } = await readRegistrations(coinDbPath);
  const purposes = layout.PURPOSE_IDS.map((purposeId) => inspectPurpose(directories, purposeId,
    registrations[purposeId] || null));
  const directorySync = probeDataFolders(coinDbPath, directories, probe);
  // The guard never runs under test-control, so a test-control data root has no count.
  const ownerDmStartGuard = runtimeMode === 'test-control'
    ? { state: 'not-applicable', cause: null, consecutiveFailures: null, threshold: null, suppressNextStart: false }
    : inspectOwnerDmStartGuard(directories.base);
  const report = {
    runtimeMode,
    directories: { base: directories.base, ledgerDirectory: directories.ledgerDirectory,
      witnessDirectory: directories.witnessDirectory },
    registrationsAvailable: available,
    directorySync,
    ownerDmStartGuard,
    purposes,
  };
  io.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatStatus(report));
  const attention = !available || ['failed', 'unsupported'].includes(directorySync.result) ||
    ownerDmStartGuard.suppressNextStart ||
    purposes.some((item) => item.verdict === 'anomaly' || item.verdict === 'in-use');
  return attention ? 2 : 0;
}

// reset-start-failures: the count back to 0, with the bot stopped.
function runResetStartFailures(options, env, io, now) {
  const { directories, runtimeMode } = resolvePaths(options, env);
  if (runtimeMode === 'test-control') throw new UsageError('test-control 的資料根不使用 Owner 私訊啟動保護；未變更任何檔案。');
  let result;
  try {
    result = resetOwnerDmStartGuard(directories.base, { now });
  } catch (error) {
    if (error?.code === 'OWNER_DM_GUARD_FILE_INVALID') {
      throw new UsageError('Owner 私訊啟動保護的紀錄不是一般檔案；請人工檢查。未變更任何檔案。');
    }
    throw error;
  }
  const before = result.before.state === 'ok' ? `${result.before.consecutiveFailures} 次`
    : result.before.state === 'absent' ? '沒有紀錄' : `state=${result.before.state}`;
  io.stdout.write(result.written
    ? `Owner 私訊啟動保護：連續啟動失敗次數已歸零（原本 ${before}）；下次啟動照常送 Owner 私訊。\n`
    : 'Owner 私訊啟動保護：沒有紀錄，不需要歸零；未變更任何檔案。\n');
  return 0;
}

function selectedPurposes(options, inspected) {
  if (!options.all) return options.purposes;
  return inspected.filter((item) => item.registration !== 'none' || item.files.length || item.staged.length)
    .map((item) => item.purposeId);
}

async function runChange(options, env, io, now) {
  const { coinDbPath, directories } = resolvePaths(options, env);
  const { available, registrations } = await readRegistrations(coinDbPath);
  if (!available) throw new UsageError('無法讀取吉幣資料庫的帳本登記；未變更任何檔案。');
  const inspected = layout.PURPOSE_IDS.map((purposeId) => inspectPurpose(directories, purposeId,
    registrations[purposeId] || null));
  const byId = new Map(inspected.map((item) => [item.purposeId, item]));
  const purposes = selectedPurposes(options, inspected);
  if (!purposes.length) throw new UsageError('沒有可處理的用途；未變更任何檔案。');
  const nowMs = now();
  // Every check runs before anything is moved, so a refusal changes nothing. Only the
  // final database's lock is checked (status reports it as in-use); a creation still in
  // progress is not detected, which is why the bot must be stopped first.
  for (const purposeId of purposes) {
    const item = byId.get(purposeId);
    if (item.verdict === 'in-use') {
      throw new UsageError(`${purposeId} 的帳本正被使用（機器人可能仍在執行）；必須先停止機器人。未變更任何檔案。`);
    }
    if (item.registration === 'invalid' && (options.command !== 'reinit' || item.ledgerIdSource !== 'database')) {
      throw new UsageError(`${purposeId} 的登記無法解析，且無法從帳本本身讀出 ID；請人工檢查。`);
    }
    // The bot accepts a reinit of an unparsable registration only when the request was
    // written after the registration's last write.
    if (item.registration === 'invalid') {
      const writtenMs = layout.registrationTimeMs(registrations[purposeId]?.updatedAt);
      if (writtenMs === null || nowMs <= writtenMs) {
        throw new UsageError(`${purposeId} 的登記無法解析，且目前系統時間沒有晚於該登記最後寫入的時間；` +
          '機器人不會接受這個請求。請先確認系統時間；未變更任何檔案。');
      }
    }
    if (item.requests.reinit || item.requests.releaseQuarantine) {
      throw new UsageError(`${purposeId} 已有待處理的請求；請先啟動機器人處理。`);
    }
    if (!item.ledgerId) throw new UsageError(`${purposeId} 沒有可辨識的帳本 ID；未變更任何檔案。`);
    if (options.confirms.get(purposeId) !== item.confirmationCode) {
      throw new UsageError(`${purposeId} 需要 --confirm ${purposeId}=<status 顯示的 8 碼>。`);
    }
    if (options.command === 'release-quarantine') {
      if (item.registration !== 'active') throw new UsageError(`${purposeId} 沒有使用中的登記，無法解除隔離。`);
      const { marker, stamp, registration } = item.quarantine;
      if (!marker && !stamp && !registration) throw new UsageError(`${purposeId} 沒有被隔離。`);
    }
  }
  const reason = options.command === 'reinit' ? 'reinit' : 'release-quarantine';
  // After the data root moved (a creating registration with other paths), the directories
  // at the current location may not exist yet; they are created as the bot would.
  layout.ensureLedgerDirectories(directories);
  for (const purposeId of purposes) {
    const item = byId.get(purposeId);
    const paths = layout.purposePaths(directories, purposeId);
    const ledgerFiles = options.command === 'reinit'
      ? [['database', paths.database], ['wal', paths.wal], ['shm', paths.shm], ['journal', paths.journal],
        ['anchor', paths.anchor], ['receipt', paths.receipt], ['marker', paths.marker],
        ['staged-database', paths.staged.database], ['staged-wal', paths.staged.wal], ['staged-shm', paths.staged.shm],
        ['staged-journal', paths.staged.journal], ['staged-anchor', paths.staged.anchor],
        ['staged-receipt', paths.staged.receipt]]
      : [['marker', paths.marker]];
    const witnessFiles = options.command === 'reinit'
      ? [['witness', paths.witness], ['stamp', paths.stamp], ['staged-witness', paths.staged.witness]]
      : [['stamp', paths.stamp]];
    const toFiles = (entries) => entries.map(([role, filePath]) => ({ role, filePath }));
    const ledgerRetired = await layout.retireFiles({ directory: directories.ledgerDirectory, purposeId,
      ledgerId: item.ledgerId, reason, nowMs, createdBy: 'script', files: toFiles(ledgerFiles), allowEmpty: true });
    const witnessRetired = await layout.retireFiles({ directory: directories.witnessDirectory, purposeId,
      ledgerId: item.ledgerId, reason, nowMs, createdBy: 'script', files: toFiles(witnessFiles) });
    await layout.writeRequest(options.command === 'reinit' ? paths.reinitRequest : paths.releaseRequest, {
      schema: 1,
      kind: reason,
      purposeId,
      ledgerId: item.ledgerId,
      requestedAtMs: nowMs,
      retired: { ledgerDirectory: ledgerRetired.name, witnessDirectory: witnessRetired ? witnessRetired.name : null },
    });
    io.stdout.write(`${purposeId}: 已移到 ${ledgerRetired.name}` +
      `${witnessRetired ? ` 與 ${witnessRetired.name}` : ''}，並寫入請求檔；下次啟動機器人時處理。\n`);
  }
  return 0;
}

// probe: the folder check of status (tests pass one with another file system or platform).
async function runSafetyLedgerCommand(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr,
  now = () => Date.now(), probe = (directory) => probeDirectorySync(directory) } = {}) {
  const io = { stdout, stderr };
  let command = null;
  try {
    const options = parseArguments(argv);
    command = options.command;
    if (options.command === 'reset-start-failures') return runResetStartFailures(options, env, io, now);
    return options.command === 'status' ? await runStatus(options, env, io, probe)
      : await runChange(options, env, io, now);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
    if (error instanceof layout.LedgerLayoutError) {
      stderr.write(`帳本目錄無法使用：${error.code}${error.reason ? ` (${error.reason})` : ''}\n`);
      return 2;
    }
    // A file that cannot be moved is usually one the running bot still holds.
    const held = command !== null && command !== 'status' && ['EBUSY', 'EPERM', 'EACCES'].includes(error?.code);
    stderr.write(`safety-ledger 失敗：${error?.code || error?.name || 'UNEXPECTED_ERROR'}` +
      `${held ? '（檔案可能仍被機器人使用；必須先停止機器人，再用 status 檢查）' : ''}\n`);
    return 1;
  }
}

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  runSafetyLedgerCommand(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { inspectPurpose, parseArguments, runSafetyLedgerCommand };
