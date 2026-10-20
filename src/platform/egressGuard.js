'use strict';

// The final in-process boundary before a Discord REST request leaves the bot.  It is
// deliberately below discord.js' public API and above test-control/the REST transport,
// so it sees the same request shape that Discord will receive without becoming a second
// REST client or changing its rate-limit queues.

const { types: { isProxy, isUint8Array } } = require('node:util');
const { parseProtectedGuildIds } = require('./commandRegistryAudit');
const { routeSegments } = require('./discordRoute');
const { currentExtensionContext, interactionTokenDigest, runOutsideExtensionContext } = require('./extensionContext');
const { getHostOperationContext } = require('./hostOperationContext');
const { createLinkApproval, rewriteLinks } = require('./linkPolicy');
const { currentProtectedAttempt, runOutsideProtectedAttempt } = require('./protectedRest');
const { observe } = require('./testControlObservation');
const { emitSafetyEvent: emitCatalogSafetyEvent, reportSecurityAlert } = require('./safetyEventCatalog');

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SNOWFLAKE = /^\d{16,22}$/u;
// Uploaded files, as discord.js hands them to REST (RawFile: { name, data, contentType }).
// The public features send a rendered PNG panel (games) and a UTF-8 member list (coin-admin);
// nothing else is admitted. Discord accepts at most 10 files per message.
const MAX_FILES = 10;
const MAX_FILE_NAME_LENGTH = 128;
const FILE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_-]|\.(?!\.))*\.(png|txt)$/u;
const FILE_FIELDS = new Set(['name', 'data', 'contentType']);
const FILE_CONTENT_TYPES = Object.freeze({
  png: new Set(['image/png']),
  txt: new Set(['text/plain', 'text/plain; charset=utf-8']),
  json: new Set(['application/json', 'application/json; charset=utf-8']),
  csv: new Set(['text/csv', 'text/csv; charset=utf-8']),
});
// The type each admitted copy is sent with. Without one REST guesses it from the first bytes, so a
// text file starting with "GIF89a" or "%PDF" would go out as an image or a PDF.
const SENT_CONTENT_TYPE = Object.freeze({
  png: 'image/png',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
});
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// Size limits for the files of one request, both as given and as sent. They bound what is copied
// and scanned here and stay far above what the public features send: a panel image of at most
// 960×960 pixels (under 4 MiB even uncompressed) and the member list of one role.
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 16 * 1024 * 1024;
// A verified extension uploads a file only in the answer to the interaction of its own command in a
// protected guild (see answersOwnCommand), such as an exported settings file: one UTF-8 text file
// (.json, .txt or .csv) of at most 1 MiB per request.
const EXTENSION_MAX_FILES = 1;
const EXTENSION_MAX_FILE_BYTES = 1024 * 1024;
const EXTENSION_FILE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_-]|\.(?!\.))*\.(json|txt|csv)$/u;
const PUBLIC_FILE_RULES = Object.freeze({
  name: FILE_NAME, maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_FILE_BYTES,
});
const EXTENSION_FILE_RULES = Object.freeze({
  name: EXTENSION_FILE_NAME, maxFiles: EXTENSION_MAX_FILES,
  maxFileBytes: EXTENSION_MAX_FILE_BYTES, maxTotalBytes: EXTENSION_MAX_FILE_BYTES,
});
// The bytes a typed array really holds: a subclass can answer anything to .byteLength.
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
// Holds the pass of a request the guard is sending, so the REST queue can tell it from any other.
const SENDING = Symbol('egress.sending');
const installations = new WeakMap();
let safetyEventHandler = null;

class EgressRefusal extends Error {
  constructor(reason, { retryAfterMs = null } = {}) {
    super('The Discord request was refused by the egress policy.');
    this.name = 'EgressRefusal';
    this.code = `EGRESS_${String(reason || 'REFUSED').toUpperCase()}`;
    this.terminal = true;
    if (Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0) this.retryAfterMs = retryAfterMs;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE.test(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
}

function hasReachableToJson(value) {
  for (let candidate = value; candidate; candidate = Object.getPrototypeOf(candidate)) {
    if (Object.hasOwn(Object.getOwnPropertyDescriptors(candidate), 'toJSON')) return true;
  }
  return false;
}

// REST serializes a payload after this guard returns.  A class instance or an own toJSON()
// can therefore turn a harmless-looking object into arbitrary text after we inspected it.
// So can a proxy: the descriptors read here and the reads of the copy that is sent may
// answer differently. Only JSON primitives, arrays and plain data objects without accessors
// are admissible.
function isInspectablePayload(value, seen = new Set()) {
  if (value === null || value === undefined) return true;
  if (['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (typeof value !== 'object' || seen.has(value) || isProxy(value)) return false;
  if (Array.isArray(value)) return isInspectableArray(value, seen);
  // clone() copies only the enumerable string-keyed fields of a plain object, and each of them is
  // checked below, so a hidden or Symbol-keyed property never reaches the transport.
  if (!isPlainObject(value) || hasReachableToJson(value)) return false;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (typeof descriptor.get === 'function' || typeof descriptor.set === 'function') return false;
    if (descriptor.enumerable && !isInspectablePayload(descriptor.value, seen)) return false;
  }
  seen.delete(value);
  return true;
}

// clone() calls the map() of an array, and hasUnsafeAttachmentRename() iterates its list with
// for...of (Symbol.iterator). So an array is admitted only as an Array.prototype array of data
// elements: dense, with no own property other than its indices and length (no method, no Symbol
// key, no hidden element), and not a subclass or a re-prototyped array whose methods would answer
// those reads.
function isInspectableArray(value, seen) {
  if (Object.getPrototypeOf(value) !== Array.prototype || hasReachableToJson(value)) return false;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const { length } = value;
  // One key per index plus length: a hole or any extra key makes the count differ.
  if (keys.length !== length + 1) return false;
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string') return false;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) return false;
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return false;
    if (!isInspectablePayload(descriptor.value, seen)) return false;
  }
  seen.delete(value);
  return true;
}

// The fields of a request that the guard reads from the caller's object by name.
const REQUEST_FIELDS = new Set(['method', 'fullRoute', 'versioned', 'body', 'files', 'appendToFormData', 'passThroughBody', 'dispatcher']);

// Reads each field of a caller's request once, before any check. A getter or a Proxy trap runs the
// caller's code, so a field read later could answer differently from the value that was checked.
// The fields above are returned as values; the other enumerable fields (headers, query, reason,
// signal, ...) are copied as a spread copies them, so the send reads no field of the caller's object.
// An object held in one of these fields is still the caller's, and REST may read it when it sends.
function readRequest(options) {
  const others = {};
  if (options !== null && typeof options === 'object') {
    for (const key of Reflect.ownKeys(options)) {
      if (REQUEST_FIELDS.has(key) || !Reflect.getOwnPropertyDescriptor(options, key)?.enumerable) continue;
      Object.defineProperty(others, key, { value: options[key], enumerable: true, writable: true, configurable: true });
    }
  }
  return {
    others,
    method: String(options?.method || '').toUpperCase(),
    fullRoute: options?.fullRoute,
    versioned: options?.versioned,
    body: options?.body,
    files: options?.files,
    appendToFormData: options?.appendToFormData,
    passThroughBody: options?.passThroughBody,
    dispatcher: options?.dispatcher,
  };
}

function readPrivateGuildIds(env = process.env) {
  return Object.freeze([...(parseProtectedGuildIds(env?.XIAOJI_PROTECTED_GUILD_IDS) || [])]);
}

function setEgressSafetyEventHandler(handler) {
  if (handler !== null && typeof handler !== 'function') throw new TypeError('Egress safety handler must be a function.');
  const previous = safetyEventHandler;
  safetyEventHandler = handler;
  return () => {
    if (safetyEventHandler === handler) safetyEventHandler = previous;
  };
}

function emitSafetyEvent(event) {
  try {
    // Safety notification work must never inherit authority from a protected delivery or
    // a private extension.  The host operation context remains available to its caller.
    runOutsideProtectedAttempt(() => runOutsideExtensionContext(() => {
      if (typeof event?.code === 'string') emitCatalogSafetyEvent(event.code, event);
      if (safetyEventHandler) Promise.resolve(safetyEventHandler(Object.freeze({ ...event }))).catch(() => {});
    }));
  } catch {
    // Observability is never allowed to change the result of a Discord request.
  }
}

// A blocked request is reported to the Owner as a security alert of kind egress-block (the EGRESS_* code itself is
// routine: log line and observation only). The guild is the one the request was aimed at, or else the one the host
// operation runs for; whoever started the operation is its actor. Like every safety event it is raised outside any
// protected attempt or extension context, and it can never change the result of the request.
function reportBlockedRequest(classification) {
  try {
    runOutsideProtectedAttempt(() => runOutsideExtensionContext(() => {
      const host = getHostOperationContext();
      const guildId = classification?.targetGuildId || host?.guildId || null;
      reportSecurityAlert('egress-block', {
        guildId,
        // No server for the request and none for the operation: a direct message is only an operation that says so
        // (its scope starts with dm:); anything else (a background run) is a place that is not known.
        placeUnknown: !guildId && !String(host?.scope || '').startsWith('dm:'),
        actorId: host?.actorId || null,
        channelId: host?.channelId || null,
        messageId: host?.sourceEventId || null,
      });
    }));
  } catch {
    // Observability is never allowed to change the result of a Discord request.
  }
}

function normalizedSegments(fullRoute) {
  const segments = routeSegments(fullRoute);
  return segments && segments.length ? segments : null;
}

function matches(segments, method, ...parts) {
  return method === parts.shift() && segments.length === parts.length && parts.every((part, index) =>
    part === '*' || part === segments[index]);
}

function routeTargetGuild(segments, resolveChannelGuild) {
  if (segments[0] === 'guilds' && isSnowflake(segments[1])) return segments[1];
  if (segments[0] === 'channels' && isSnowflake(segments[1])) {
    const value = resolveChannelGuild?.(segments[1]);
    return isSnowflake(value) ? value : null;
  }
  return null;
}

function classifyRoute(method, segments, resolveChannelGuild) {
  const targetGuildId = routeTargetGuild(segments, resolveChannelGuild);
  const route = segments.join('/');
  const channelId = segments[0] === 'channels' && isSnowflake(segments[1]) ? segments[1] : null;
  if (method === 'GET') return { kind: 'read', route, targetGuildId, channelId };
  if (matches(segments, method, 'POST', 'guilds', '*', 'bulk-ban') ||
      matches(segments, method, 'POST', 'guilds', '*', 'prune') ||
      matches(segments, method, 'DELETE', 'guilds', '*')) return { kind: 'always_blocked', route, targetGuildId };
  if (matches(segments, method, 'DELETE', 'users', '@me', 'guilds', '*')) {
    return { kind: 'leave', route, targetGuildId: segments[3] };
  }
  if (matches(segments, method, 'DELETE', 'channels', '*') ||
      matches(segments, method, 'DELETE', 'channels', '*', 'messages', '*')) {
    return { kind: 'delete', route, targetGuildId, resourceId: segments.at(-1), channelId: segments[1] };
  }
  const publicWrite =
    matches(segments, method, 'POST', 'interactions', '*', '*', 'callback') ||
    matches(segments, method, 'POST', 'webhooks', '*', '*') ||
    (segments[0] === 'webhooks' && segments.length === 5 && ['GET', 'PATCH', 'DELETE'].includes(method) && segments[3] === 'messages') ||
    matches(segments, method, 'POST', 'channels', '*', 'messages') ||
    matches(segments, method, 'PATCH', 'channels', '*', 'messages', '*') ||
    (segments.length === 7 && segments[0] === 'channels' && segments[2] === 'messages' && segments[4] === 'reactions' &&
      segments[6] === '@me' && ['PUT', 'DELETE'].includes(method)) ||
    matches(segments, method, 'POST', 'channels', '*', 'messages', '*', 'threads') ||
    matches(segments, method, 'POST', 'channels', '*', 'threads') ||
    matches(segments, method, 'POST', 'channels', '*', 'typing') ||
    (segments.length === 4 && segments[0] === 'channels' && segments[2] === 'thread-members' && segments[3] === '@me' &&
      ['PUT', 'DELETE'].includes(method)) ||
    matches(segments, method, 'POST', 'users', '@me', 'channels');
  return { kind: publicWrite ? 'public_write' : 'private_write', route, targetGuildId, channelId };
}

function isMessageRoute(method, segments) {
  if (segments[0] === 'channels' && segments[2] === 'messages' && ['POST', 'PATCH'].includes(method)) return true;
  if (segments[0] === 'webhooks') return true;
  return segments[0] === 'interactions' && method === 'POST' && segments.at(-1) === 'callback';
}

// Every link Discord may show: with a scheme or without one (bare invites and bare domains alike).
// Protected free-text sources and the Owner notice are cleaned with the same options before they get here
// (workPenaltySource.js, workReminderSource.js, ownerSafetyNotifier.js). bareDomains is left off for the
// text that nobody reads as a message and that nobody follows: the identifier of a component and the value
// of a select option or an autocomplete choice (see scrubPlainPayload), which the bot reads back as it wrote
// it, and the content of an uploaded text file (see inspectFile), which Discord does not turn into links
// and whose names (a key such as announcement.channel.id of an exported setting) are not addresses. A
// link with a scheme and an invite are removed in them all the same.
function rewriteText(value, approval, { bareDomains = true } = {}) {
  if (typeof value !== 'string') return { value, changed: false };
  const result = rewriteLinks(value, {
    approve: approval.approve, maskedLink: 'label-and-marker', bareInvites: true, bareDomains,
  });
  return { value: result.text, changed: result.rewritten };
}

function fileExtension(name, pattern = FILE_NAME) {
  if (typeof name !== 'string' || name.length > MAX_FILE_NAME_LENGTH) return null;
  return pattern.exec(name)?.[1] ?? null;
}

// Own data properties only: an accessor could answer one value here and another to REST.
function dataFields(value, allowed) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fields = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key) || !Object.hasOwn(descriptors[key], 'value')) return null;
    fields[key] = descriptors[key].value;
  }
  return fields;
}

// The bytes of a view as measured: a copy of at most `given` bytes, so a view that grew meanwhile
// costs no more memory than was measured. Null when the view no longer has the measured length
// after the copy (it grew or shrank), so the file is refused.
function copyMeasured(view, given) {
  let bytes;
  try { bytes = Buffer.copyBytesFrom(view, 0, given); } catch { return null; }
  return Reflect.apply(typedArrayByteLength, view, []) === given ? bytes : null;
}

// One RawFile, or null when it is not admitted. The returned copy (bytes included) is what
// REST sends, so nothing the caller changes after this check can reach Discord. A text file (any
// kind but png) is link-rewritten like any other outbound text. budget is the most bytes the file
// may have, given (a string counts its UTF-16 code units, never more than its UTF-8 bytes) or
// sent; size is the larger of the two. rules name the admitted names and the size of one file.
function inspectFile(file, approval, budget, rules) {
  if (!isPlainObject(file)) return null;
  const fields = dataFields(file, FILE_FIELDS);
  const extension = fileExtension(fields?.name, rules.name);
  if (!extension) return null;
  const { name, data, contentType } = fields;
  if (contentType !== undefined && !FILE_CONTENT_TYPES[extension].has(contentType)) return null;
  const limit = Math.min(rules.maxFileBytes, budget);
  if (extension === 'png') {
    if (!isUint8Array(data)) return null;
    // Measured before the copy, which takes at most that many bytes, and measured again after it: a
    // view of a growable shared buffer can grow in between, and a file whose size changed is refused.
    const given = Reflect.apply(typedArrayByteLength, data, []);
    if (given < PNG_SIGNATURE.length || given > limit) return null;
    const bytes = copyMeasured(data, given);
    if (!bytes || bytes.length < PNG_SIGNATURE.length || bytes.length > limit) return null;
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
    return {
      file: Object.freeze({ name, data: bytes, contentType: SENT_CONTENT_TYPE.png }),
      size: Math.max(given, bytes.length), changed: false,
    };
  }
  let text;
  let given;
  if (typeof data === 'string') {
    given = data.length;
    if (given > limit) return null;
    text = data;
  } else if (isUint8Array(data)) {
    given = Reflect.apply(typedArrayByteLength, data, []);
    if (given > limit) return null;
    const copied = copyMeasured(data, given);
    if (!copied) return null;
    try { text = UTF8.decode(copied); } catch { return null; }
  } else return null;
  // Links with a scheme and invites only: a name such as announcement.channel.id in an exported file is a
  // key, not a link, and rewriting it would corrupt the file (and its structure).
  const rewritten = rewriteText(text, approval, { bareDomains: false });
  const bytes = Buffer.from(rewritten.value, 'utf8');
  if (bytes.length > limit) return null;
  return {
    file: Object.freeze({ name, data: bytes, contentType: SENT_CONTENT_TYPE[extension] }),
    size: Math.max(given, bytes.length), changed: rewritten.changed,
  };
}

// The files of a request: undefined, or a plain array of at most rules.maxFiles admitted files with
// distinct names and at most rules.maxTotalBytes together. Returns null when any part is not
// admitted.
function inspectFiles(files, approval, rules) {
  if (files === undefined) return { files: undefined, names: new Set(), changed: false };
  if (!Array.isArray(files) || Object.getPrototypeOf(files) !== Array.prototype) return null;
  // Read once: a proxy could answer a small length to this check and a larger one to the loop.
  const count = files.length;
  if (!Number.isSafeInteger(count) || count < 0 || count > rules.maxFiles) return null;
  const descriptors = Object.getOwnPropertyDescriptors(files);
  const copies = [];
  const names = new Set();
  let changed = false;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    const inspected = inspectFile(descriptor.value, approval, rules.maxTotalBytes - total, rules);
    if (!inspected || names.has(inspected.file.name)) return null;
    names.add(inspected.file.name);
    copies.push(inspected.file);
    changed ||= inspected.changed;
    total += inspected.size;
  }
  return { files: Object.freeze(copies), names, changed };
}

// Discord lets attachments[].filename rename an uploaded file, so a body may only give a name
// an uploaded file could have had itself (pattern: the names the request's file rules admit). The
// list stands in a message body, in the data of an interaction response, or in the starting message
// of a new thread.
function hasUnsafeAttachmentRename(body, pattern = FILE_NAME) {
  for (const list of [body?.attachments, body?.data?.attachments, body?.message?.attachments]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (isPlainObject(entry) && entry.filename !== undefined && entry.filename !== null &&
          !fileExtension(entry.filename, pattern)) {
        return true;
      }
    }
  }
  return false;
}

// A forwarded message (message_reference of type 1, which discord.js sends for a forward) carries the content
// of another message that this guard cannot read: the text, embeds and files of the original are copied by
// Discord after the check, so the links in them would never be seen. A reply (type 0, or none) carries no
// content of its own and is admitted. The reference stands in a message body, in the data of an interaction
// response and in the starting message of a new thread (like the attachment list above); any type but 0
// and any shape that is not a plain object is refused, so that a type added later is not let through.
function hasForwardedReference(body) {
  for (const holder of [body, body?.data, body?.message]) {
    if (!isPlainObject(holder) || !Object.hasOwn(holder, 'message_reference')) continue;
    const reference = holder.message_reference;
    if (reference === undefined || reference === null) continue;
    if (!isPlainObject(reference)) return true;
    const { type } = reference;
    if (type !== undefined && type !== null && type !== 0) return true;
  }
  return false;
}

// True when a request answers the interaction a verified extension command runs for, in a protected
// guild: the initial response to that interaction, a follow-up message or an edit of one of its
// messages. The host records the interaction when it opens the command's context (extensionContext.js);
// a hook, a guard, a preflight or any other interaction never matches. Route segments are lower case,
// and so is the token the digest was made from.
function answersOwnCommand(extension, method, segments, privateIds) {
  if (extension?.entry !== 'command' || !privateIds.has(extension.sourceGuildId)) return false;
  const digest = extension.interactionTokenDigest;
  if (typeof digest !== 'string' || !isSnowflake(extension.interactionId)) return false;
  const ownToken = (token) => interactionTokenDigest(token) === digest;
  if (matches(segments, method, 'POST', 'interactions', '*', '*', 'callback')) {
    return segments[1] === extension.interactionId && ownToken(segments[2]);
  }
  if (matches(segments, method, 'POST', 'webhooks', '*', '*') ||
      matches(segments, method, 'PATCH', 'webhooks', '*', '*', 'messages', '*')) return ownToken(segments[2]);
  return false;
}

function scrubTextFields(value, approval, changes, allowedAttachmentNames) {
  if (typeof value === 'string') return rewriteText(value, approval);
  if (Array.isArray(value)) return value.map((entry) => scrubTextFields(entry, approval, changes, allowedAttachmentNames));
  if (!isPlainObject(value)) return value;
  const copy = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:url|.*_url)$/iu.test(key)) {
      copy[key] = scrubUrl(entry, approval, changes, allowedAttachmentNames);
    } else if (typeof entry === 'string') {
      const rewritten = rewriteText(entry, approval);
      if (rewritten.changed) changes.link = true;
      copy[key] = rewritten.value;
    } else {
      copy[key] = scrubTextFields(entry, approval, changes, allowedAttachmentNames);
    }
  }
  return copy;
}

function scrubUrl(value, approval, changes, allowedAttachmentNames) {
  if (typeof value !== 'string') return value;
  if (value.startsWith('attachment://')) {
    const encodedName = value.slice('attachment://'.length);
    let name = encodedName;
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      changes.link = true;
      return null;
    }
    if (allowedAttachmentNames?.has(name)) return value;
    changes.link = true;
    return null;
  }
  const approved = approval.approve(value);
  if (approved) return approved;
  changes.link = true;
  return null;
}

function scrubEmbed(embed, approval, changes, allowedAttachmentNames) {
  if (!isPlainObject(embed)) return embed;
  const copy = clone(embed);
  for (const key of ['title', 'description']) {
    const rewritten = rewriteText(copy[key], approval);
    if (rewritten.changed) changes.link = true;
    if (typeof copy[key] === 'string') copy[key] = rewritten.value;
  }
  for (const parent of ['author', 'footer', 'provider', 'video']) {
    if (!isPlainObject(copy[parent])) continue;
    const rewritten = rewriteText(copy[parent].name ?? copy[parent].text, approval);
    if (rewritten.changed) changes.link = true;
    if (typeof copy[parent].name === 'string') copy[parent].name = rewritten.value;
    if (typeof copy[parent].text === 'string') copy[parent].text = rewritten.value;
    for (const key of Object.keys(copy[parent])) {
      if (/url$/iu.test(key)) {
        const safe = scrubUrl(copy[parent][key], approval, changes, allowedAttachmentNames);
        if (safe === null) delete copy[parent][key]; else copy[parent][key] = safe;
      }
    }
  }
  if (Array.isArray(copy.fields)) {
    copy.fields = copy.fields.map((field) => {
      if (!isPlainObject(field)) return field;
      const next = clone(field);
      for (const key of ['name', 'value']) {
        const rewritten = rewriteText(next[key], approval);
        if (rewritten.changed) changes.link = true;
        if (typeof next[key] === 'string') next[key] = rewritten.value;
      }
      return next;
    });
  }
  for (const key of ['url', 'image', 'thumbnail']) {
    if (key === 'url') {
      const safe = scrubUrl(copy.url, approval, changes, allowedAttachmentNames);
      if (safe === null) delete copy.url; else if (safe !== undefined) copy.url = safe;
    } else if (isPlainObject(copy[key])) {
      const safe = scrubUrl(copy[key].url, approval, changes, allowedAttachmentNames);
      if (safe === null) delete copy[key]; else if (safe !== undefined) copy[key].url = safe;
    }
  }
  return copy;
}

// The lists whose objects the bot reads back by their "value" (the options of a select menu, the choices of
// an autocomplete answer), and nothing else: the value is never shown (the label or the name is, and is
// scanned in full), so a dotted verb such as "act.top" in it must not become a domain, as in a custom_id.
// Links with a scheme and invites are still removed from it. A "value" anywhere else (the field of an
// embed, the prefilled text of an input) is shown, and is scanned like any other text.
const VALUE_LIST_KEYS = new Set(['options', 'choices']);

// readBack is true for the objects of such a list.
function scrubComponents(value, approval, changes, allowedAttachmentNames, readBack = false) {
  if (Array.isArray(value)) {
    return value.map((entry) => scrubComponents(entry, approval, changes, allowedAttachmentNames, readBack)).filter(Boolean);
  }
  if (!isPlainObject(value)) return value;
  const copy = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'url') {
      const safe = scrubUrl(entry, approval, changes, allowedAttachmentNames);
      if (safe !== null) copy[key] = safe;
    } else if (readBack && key === 'value' && typeof entry === 'string') {
      const rewritten = rewriteText(entry, approval, { bareDomains: false });
      if (rewritten.changed) changes.link = true;
      copy[key] = rewritten.value;
    } else if (['label', 'placeholder', 'description', 'content', 'value', 'title', 'name'].includes(key) && typeof entry === 'string') {
      const rewritten = rewriteText(entry, approval);
      if (rewritten.changed) changes.link = true;
      copy[key] = rewritten.value;
    } else if (Array.isArray(entry) || isPlainObject(entry)) {
      copy[key] = scrubComponents(entry, approval, changes, allowedAttachmentNames, VALUE_LIST_KEYS.has(key));
    } else copy[key] = entry;
  }
  // A link button with its URL removed is not a useful component and Discord rejects it.
  if (Number(copy.style) === 5 && !copy.url) return null;
  return copy;
}

// This covers the text fields of approved private extension routes as well as Discord fields
// introduced after this bot version.  The payload was already proven to be plain JSON data,
// so recursive traversal cannot invoke custom serialization code.
// readBack is true for the objects of a list the bot reads back by their "value" (see VALUE_LIST_KEYS).
function scrubPlainPayload(value, approval, changes, allowedAttachmentNames, readBack = false) {
  if (typeof value === 'string') {
    const rewritten = rewriteText(value, approval);
    if (rewritten.changed) changes.link = true;
    return rewritten.value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrubPlainPayload(entry, approval, changes, allowedAttachmentNames, readBack));
  }
  if (!isPlainObject(value)) return value;
  const copy = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:url|.*_url)$/iu.test(key)) {
      const safe = scrubUrl(entry, approval, changes, allowedAttachmentNames);
      if (safe !== null) copy[key] = safe;
    } else if ((key === 'custom_id' || (readBack && key === 'value')) && typeof entry === 'string') {
      // The identifier of a control is the bot's own code, never shown and never a link, and the bot reads
      // it back as it wrote it: a dotted verb such as "act.top" must not become a domain. So is the value
      // of a select option or of an autocomplete choice. Links in them are still removed.
      const rewritten = rewriteText(entry, approval, { bareDomains: false });
      if (rewritten.changed) changes.link = true;
      copy[key] = rewritten.value;
    } else {
      copy[key] = scrubPlainPayload(entry, approval, changes, allowedAttachmentNames, VALUE_LIST_KEYS.has(key));
    }
  }
  return copy;
}

function scrubBody(body, approval, {
  allowPrivilegedMentions = false,
  includeMentions = true,
  includeNestedMentions = false,
  allowedAttachmentNames = new Set(),
} = {}) {
  if (body === null || body === undefined) return { body, changes: { link: false, mention: false } };
  const copy = clone(body);
  const changes = { link: false, mention: false };
  for (const key of ['content', 'username', 'thread_name']) {
    const rewritten = rewriteText(copy[key], approval);
    if (rewritten.changed) changes.link = true;
    if (typeof copy[key] === 'string') copy[key] = rewritten.value;
  }
  const avatarUrl = scrubUrl(copy.avatar_url, approval, changes, allowedAttachmentNames);
  if (avatarUrl === null) delete copy.avatar_url;
  else if (avatarUrl !== undefined) copy.avatar_url = avatarUrl;
  if (Array.isArray(copy.embeds)) copy.embeds = copy.embeds.map((embed) => scrubEmbed(embed, approval, changes, allowedAttachmentNames));
  if (Array.isArray(copy.components)) copy.components = scrubComponents(copy.components, approval, changes, allowedAttachmentNames);
  if (isPlainObject(copy.poll)) copy.poll = scrubTextFields(copy.poll, approval, changes, allowedAttachmentNames);
  if (Array.isArray(copy.attachments)) {
    copy.attachments = copy.attachments.map((attachment) => {
      if (!isPlainObject(attachment)) return attachment;
      const next = clone(attachment);
      const rewritten = rewriteText(next.description, approval);
      if (rewritten.changed) changes.link = true;
      if (typeof next.description === 'string') next.description = rewritten.value;
      return next;
    });
  }
  if (isPlainObject(copy.data)) {
    const nested = scrubBody(copy.data, approval, {
      allowPrivilegedMentions,
      includeMentions: includeNestedMentions,
      includeNestedMentions,
      allowedAttachmentNames,
    });
    copy.data = nested.body;
    changes.link ||= nested.changes.link;
    changes.mention ||= nested.changes.mention;
  }
  if (includeMentions) {
    const mentions = isPlainObject(copy.allowed_mentions) ? clone(copy.allowed_mentions) : { parse: [] };
    const oldParse = Array.isArray(mentions.parse) ? mentions.parse.map(String) : [];
    const newParse = allowPrivilegedMentions ? oldParse : oldParse.filter((entry) => entry !== 'everyone' && entry !== 'roles');
    if (!allowPrivilegedMentions && (oldParse.length !== newParse.length || (Array.isArray(mentions.roles) && mentions.roles.length))) {
      changes.mention = true;
    }
    mentions.parse = newParse;
    if (!allowPrivilegedMentions) mentions.roles = [];
    if (mentions.replied_user === true) changes.mention = true;
    mentions.replied_user = false;
    copy.allowed_mentions = mentions;
  }
  return { body: scrubPlainPayload(copy, approval, changes, allowedAttachmentNames), changes };
}

function privateContextAllowed(context, targetGuildId, privateGuildIds) {
  return Boolean(context && targetGuildId && privateGuildIds.has(targetGuildId));
}

function isSelfCreated(record, kind, id, now) {
  const value = record.get(id);
  return Boolean(value && value > now);
}

// The REST can be reached without request() as well: queueRequest() puts a request in its queue
// unchecked, the agent is the dispatcher of every request, and options.api and options.version
// begin every URL. Once the guard is installed the queue takes only a request the guard is sending
// (one that holds a current pass, also when a layer below forwards a copy of it), and the others
// keep the values they had. discord.js uses none of them; request() calls queueRequest() itself.
function lockRestEntries(rest, isSending) {
  const fix = (target, name, value) =>
    Object.defineProperty(target, name, { value, writable: false, configurable: false, enumerable: true });
  if (typeof rest.queueRequest === 'function') {
    const queueRequest = rest.queueRequest;
    fix(rest, 'queueRequest', async function queueGuardedRequest(request) {
      if (!isSending(request)) throw new TypeError('A Discord request must be sent through rest.request().');
      return Reflect.apply(queueRequest, rest, [request]);
    });
  }
  if (typeof rest.setAgent === 'function') {
    fix(rest, 'setAgent', function setAgent() {
      throw new TypeError('The REST agent cannot be changed once the egress guard is installed.');
    });
  }
  if (Object.hasOwn(rest, 'agent')) fix(rest, 'agent', rest.agent);
  const { options } = rest;
  if (options && typeof options === 'object') {
    for (const name of ['api', 'version']) if (Object.hasOwn(options, name)) fix(options, name, options[name]);
    // The same lock protected delivery puts on it, so either may be installed first.
    fix(rest, 'options', options);
  }
}

function installEgressGuard(rest, {
  approvedReleaseTag,
  privateGuildIds = [],
  ownerId = null,
  resolveChannelGuild = () => null,
  logger = null,
  monotonicNow = () => performance.now(),
  selfCreatedTtlMs = 15 * 60 * 1000,
  admit = null,
  lock = true,
} = {}) {
  if (!rest || typeof rest.request !== 'function') throw new TypeError('A Discord REST client is required.');
  const existing = installations.get(rest);
  if (existing) return existing;
  if (typeof approvedReleaseTag !== 'string' || !approvedReleaseTag) throw new TypeError('An approved release tag is required.');
  const privateIds = new Set(Array.from(privateGuildIds, String).filter(isSnowflake));
  const approval = createLinkApproval({ approvedReleaseTag, releaseTags: 'stable' });
  const channels = new Map();
  const messages = new Map();
  const original = rest.request.bind(rest);
  // The passes of the requests this guard is sending right now.
  const passes = new WeakSet();
  let admission = admit;
  let lastLogAt = 0;

  function pruneRecords(now) {
    for (const [id, expiresAt] of channels) if (expiresAt <= now) channels.delete(id);
    for (const [id, expiresAt] of messages) if (expiresAt <= now) messages.delete(id);
  }

  function refusal(reason) {
    return new EgressRefusal(reason);
  }

  function evaluate(options, { mutate = false } = {}) {
    // Every field the request is judged and sent by is read here, once, before the first check.
    const {
      others, method, fullRoute, versioned, body, files: givenFiles, appendToFormData, passThroughBody, dispatcher,
    } = readRequest(options);
    const segments = normalizedSegments(fullRoute);
    if (!METHODS.has(method)) return { error: refusal('METHOD') };
    if (!segments) return { error: refusal('NON_CANONICAL_ROUTE') };
    if (versioned === false) return { error: refusal('UNVERSIONED') };
    // A dispatcher of the caller would receive the finished request, token included, and could
    // change where it goes and what it carries. discord.js never gives one.
    if (passThroughBody === true || dispatcher !== undefined || !isInspectablePayload(body)) {
      return { error: refusal('UNINSPECTABLE_BODY') };
    }
    // The checks and the send use this copy, which holds plain data only. The file list below can
    // run the caller's code; that code may change the caller's body, but not this copy.
    const checked = clone(body);
    if (hasForwardedReference(checked)) return { error: refusal('FORWARD_BLOCKED') };
    const extension = currentExtensionContext();
    const protectedAttempt = currentProtectedAttempt();
    // Files are admitted for the public features, and for a verified extension only in the answer
    // to its own command's interaction in a protected guild, under its narrower rules. A protected
    // delivery is a fixed text notice and never carries a file.
    const fileRules = extension ? EXTENSION_FILE_RULES : PUBLIC_FILE_RULES;
    const files = inspectFiles(givenFiles, approval, fileRules);
    const uploading = Boolean(files?.files?.length);
    if (!files || hasUnsafeAttachmentRename(checked, uploading ? fileRules.name : FILE_NAME) ||
        (uploading && (protectedAttempt || appendToFormData ||
          (extension && !answersOwnCommand(extension, method, segments, privateIds))))) {
      return { error: refusal('UNINSPECTABLE_FILE') };
    }
    const classification = classifyRoute(method, segments, resolveChannelGuild);
    const now = monotonicNow();
    pruneRecords(now);
    if (classification.kind === 'always_blocked') return { error: refusal('ALWAYS_BLOCKED'), classification };
    if (classification.kind === 'leave') {
      if (privateIds.has(classification.targetGuildId)) return { error: refusal('PRIVATE_GUILD_LEAVE'), classification };
      // Only two callers may leave a guild: the automatic leave of the public-effect runtime,
      // which never runs inside a private extension (nothing issues one any more: guilds are not
      // reviewed, so this path is dormant), and an Owner's own slash command of a
      // verified extension in a protected guild. Hooks, guards and preflights run on events
      // nobody chose, so they cannot leave. Both share the egress limiter's leave cap. The Owner
      // must be the user the host recorded as running the command when it opened the extension
      // context, and the actor of the host operation as well.
      const host = getHostOperationContext();
      const allowed = (protectedAttempt?.label === 'safety.public-effects' && !extension) ||
        (extension?.entry === 'command' && extension.sourceGuildId && privateIds.has(extension.sourceGuildId) &&
          isSnowflake(ownerId) && extension.actorId === ownerId && host?.actorId === ownerId);
      if (!allowed) return { error: refusal('LEAVE_NOT_OWNER'), classification };
    }
    if (classification.kind === 'delete') {
      const record = classification.route.includes('/messages/') ? messages : channels;
      if (!isSelfCreated(record, classification.kind, classification.resourceId, now) &&
          !privateContextAllowed(extension, classification.targetGuildId, privateIds)) {
        return { error: refusal(extension ? 'NOT_PRIVATE_GUILD' : 'NO_EXTENSION_CONTEXT'), classification };
      }
    }
    if (classification.kind === 'private_write' && !privateContextAllowed(extension, classification.targetGuildId, privateIds)) {
      return { error: refusal(extension ? (classification.targetGuildId ? 'NOT_PRIVATE_GUILD' : 'UNKNOWN_CHANNEL_GUILD') : 'NO_EXTENSION_CONTEXT'), classification };
    }
    // Interaction and webhook routes do not carry a guild ID.  Their verified extension
    // context does, and those responses are bound to that invocation, so it is the only
    // safe fallback for the user-approved private-guild mention exception.
    const mentionGuildId = classification.targetGuildId || extension?.sourceGuildId || null;
    const allowPrivilegedMentions = Boolean(extension && privateContextAllowed(extension, mentionGuildId, privateIds));
    const transformed = scrubBody(checked, approval, {
      allowPrivilegedMentions,
      includeMentions: isMessageRoute(method, segments) && segments[0] !== 'interactions',
      includeNestedMentions: segments[0] === 'interactions',
      allowedAttachmentNames: files.names,
    });
    transformed.changes.link ||= files.changed;
    if (protectedAttempt && (transformed.changes.link || transformed.changes.mention)) {
      return { error: refusal('PROTECTED_REWRITE_BLOCKED'), classification, changes: transformed.changes };
    }
    return {
      method, fullRoute, versioned, segments, classification, body: transformed.body, files: files.files,
      others, changes: transformed.changes, extension, protectedAttempt,
    };
  }

  function recordCreated(result, evaluated) {
    const id = typeof result?.id === 'string' ? result.id : null;
    if (!id || !isSnowflake(id)) return;
    const expiresAt = monotonicNow() + selfCreatedTtlMs;
    const { segments, method } = evaluated;
    if (method === 'POST' && segments[0] === 'channels' && (segments[2] === 'threads' || segments[4] === 'threads')) channels.set(id, expiresAt);
    if (method === 'POST' && segments[0] === 'channels' && segments[2] === 'messages') messages.set(id, expiresAt);
  }

  async function guardedRequest(options) {
    const evaluated = evaluate(options, { mutate: true });
    if (evaluated.error) {
      observe('TEST_OBS_EGRESS_ROUTE_BLOCKED');
      emitSafetyEvent({ code: evaluated.error.code, kind: 'blocked' });
      reportBlockedRequest(evaluated.classification);
      throw evaluated.error;
    }
    // The limiter gets the evaluated segments themselves: the joined route is percent-decoded
    // (a ✅ reaction becomes non-ASCII) and would no longer parse as a canonical route there.
    if (typeof admission === 'function') await admission(Object.freeze({
      method: evaluated.method, segments: Object.freeze([...evaluated.segments]),
      route: evaluated.classification.route, kind: evaluated.classification.kind,
      targetGuildId: evaluated.classification.targetGuildId, channelId: evaluated.classification.channelId || null,
      resourceId: evaluated.classification.resourceId || null, body: evaluated.body,
      actorId: getHostOperationContext()?.actorId || null,
      contextChannelId: getHostOperationContext()?.channelId || null,
      protected: Boolean(evaluated.protectedAttempt),
      privateExtension: Boolean(evaluated.classification.kind === 'private_write' &&
        privateContextAllowed(evaluated.extension, evaluated.classification.targetGuildId, privateIds)),
      // A verified extension acting in a protected guild: its management routes use the wider
      // protected-guild budgets of the egress limiter.
      protectedGuildExtension: privateContextAllowed(evaluated.extension, evaluated.classification.targetGuildId, privateIds),
    }));
    if (evaluated.changes.link) {
      observe('TEST_OBS_EGRESS_LINK_REWRITTEN');
      emitSafetyEvent({ code: 'EGRESS_LINK_REWRITTEN', kind: 'rewritten' });
    }
    if (evaluated.changes.mention) {
      observe('TEST_OBS_EGRESS_MENTION_STRIPPED');
      emitSafetyEvent({ code: 'EGRESS_MENTION_STRIPPED', kind: 'rewritten' });
    }
    if ((evaluated.changes.link || evaluated.changes.mention) && monotonicNow() - lastLogAt >= 60_000) {
      lastLogAt = monotonicNow();
      logger?.warn?.('[EGRESS] outbound content was normalized.');
    }
    // REST reads the request only now, after the admission wait. Everything that decides where it
    // goes and what it carries is therefore taken from the check, not from the caller's object as it
    // is by then; a request checked without files is sent without files, and as JSON, and none is
    // sent through a dispatcher of the caller. The other fields are the copies taken when it was read.
    const pass = Object.freeze({});
    passes.add(pass);
    let result;
    try {
      result = await original({
        ...evaluated.others,
        method: evaluated.method, fullRoute: evaluated.fullRoute, versioned: evaluated.versioned,
        body: evaluated.body, files: evaluated.files, passThroughBody: false, appendToFormData: false,
        dispatcher: undefined, [SENDING]: pass,
      });
    } finally {
      passes.delete(pass);
    }
    recordCreated(result, evaluated);
    return result;
  }

  const handle = Object.freeze({
    classifyRoute(fullRoute, method = 'GET') {
      const segments = normalizedSegments(fullRoute);
      return segments ? Object.freeze(classifyRoute(String(method).toUpperCase(), segments, resolveChannelGuild)) : null;
    },
    preflight(options) {
      const result = evaluate(options);
      return Object.freeze(result.error ? { allowed: false, code: result.error.code } : { allowed: true });
    },
    setAdmission(fn) {
      if (admission !== null) throw new Error('EGRESS_ADMISSION_ALREADY_SET');
      if (typeof fn !== 'function') throw new TypeError('Egress admission callback is required.');
      admission = fn;
    },
  });
  if (lock) {
    Object.defineProperty(rest, 'request', { value: guardedRequest, writable: false, configurable: false, enumerable: true });
    lockRestEntries(rest, (request) => passes.has(request?.[SENDING]));
  } else rest.request = guardedRequest;
  installations.set(rest, handle);
  return handle;
}

function isEgressRefusal(error) {
  return error instanceof EgressRefusal;
}

module.exports = {
  installEgressGuard,
  isEgressRefusal,
  readPrivateGuildIds,
  setEgressSafetyEventHandler,
};
