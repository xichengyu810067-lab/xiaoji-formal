'use strict';

// Shape checks for the routes of Discord REST requests, shared by the code that inspects a request
// before it leaves the process.

// @discordjs/rest concatenates `${api}/v${version}${fullRoute}` and undici parses the
// result with WHATWG URL rules, which resolve dot segments (including %2e forms), treat
// "\" as "/", and strip tab/newline. Proxies or servers may also decode %2f/%5c or a
// second encoding layer. Only routes that no such step can rewrite are evaluated.
const ROUTE_CANONICAL_BASE = 'https://discord.invalid/api/v10';
const ROUTE_CANONICAL_BASE_PATH = '/api/v10';
const ROUTE_MAX_DECODE_ROUNDS = 4;
// "#" only starts a URL fragment in the raw route; once percent-decoded (for example the
// %23 of a keycap number-sign emoji reaction) it is plain path data, so decoded layers
// do not reject it.
const ROUTE_RAW_FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f\\#]/u;
const ROUTE_DECODED_FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f\\]/u;
const ROUTE_FORBIDDEN_ENCODING = /%(?:25)*(?:2e|2f|5c)/iu;
// IIS-style %uXXXX escapes, which some legacy servers decode into "." "/" or "\".
const ROUTE_IIS_UNICODE_ENCODING = /%u[0-9a-f]{4}/iu;
// Decoded bytes (one char per byte) that start an overlong or out-of-range UTF-8 form:
// C0/C1 (2-byte), E0 80-9F (3-byte), F0 80-8F (4-byte), and F5-FF (5/6-byte and invalid
// lead bytes). Legacy decoders can turn these into ".", "/" or "\".
const ROUTE_OVERLONG_UTF8 = /[\u00c0\u00c1\u00f5-\u00ff]|\u00e0[\u0080-\u009f]|\u00f0[\u0080-\u008f]/u;

function decodePercentOnce(value) {
  return value.replace(/%([0-9a-f]{2})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function isDotSegment(segment) {
  return segment === '.' || segment === '..';
}

// A route is canonical only when every decoding layer keeps the same "/" structure,
// never yields a dot segment, backslash, control character, %uXXXX escape, or overlong
// UTF-8 form, and WHATWG URL parsing leaves the path byte-for-byte unchanged.
function isCanonicalRoute(rawRoute) {
  if (ROUTE_RAW_FORBIDDEN_CHARACTERS.test(rawRoute)) return false;
  const routePath = rawRoute.split('?')[0];
  if (ROUTE_FORBIDDEN_ENCODING.test(routePath)) return false;
  let current = routePath;
  for (let round = 0; ; round += 1) {
    const segments = current.split('/');
    if (segments.some(isDotSegment) || ROUTE_DECODED_FORBIDDEN_CHARACTERS.test(current) ||
        ROUTE_IIS_UNICODE_ENCODING.test(current) || ROUTE_OVERLONG_UTF8.test(current)) return false;
    const decoded = decodePercentOnce(current);
    if (decoded === current) break;
    if (round >= ROUTE_MAX_DECODE_ROUNDS || decoded.split('/').length !== segments.length) return false;
    current = decoded;
  }
  let parsed;
  try { parsed = new URL(`${ROUTE_CANONICAL_BASE}${routePath}`); } catch { return false; }
  return parsed.pathname === `${ROUTE_CANONICAL_BASE_PATH}${routePath}`;
}

// The path segments of a canonical route for matching it against a route template: the query is
// dropped and each segment is percent-decoded once and lower-cased, so "/users/%40me/channels" gives
// ["users", "@me", "channels"]. Returns null for a route that is not a string, is not canonical, does not
// start with "/", has an empty segment ("//" or a trailing "/"), or has a segment that does not decode.
function routeSegments(fullRoute) {
  if (typeof fullRoute !== 'string' || !isCanonicalRoute(fullRoute)) return null;
  const routePath = fullRoute.split('?')[0];
  if (!routePath.startsWith('/')) return null;
  const rawSegments = routePath.slice(1).split('/');
  if (rawSegments.some((segment) => segment === '')) return null;
  const segments = [];
  for (const segment of rawSegments) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { return null; }
    segments.push(decoded.toLowerCase());
  }
  return segments;
}

module.exports = { isCanonicalRoute, routeSegments };
