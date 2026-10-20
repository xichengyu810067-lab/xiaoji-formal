'use strict';

/*
 * A real @discordjs/rest REST for the tests of the protected senders, answered by plain
 * handler functions instead of the network. The handlers are the stand-ins these tests
 * used for client.rest before: get, post, put, patch, and delete, each called as
 * handler(route, { body }) (route without the API prefix or query, body parsed from JSON or
 * null). A request that carries files reaches the transport as multipart form data, the way
 * discord.js sends attachments; its handler is called as handler(route, { body, files }), with
 * body parsed from payload_json and files as [{ key, name, type, data }] (data a Buffer). A
 * handler is looked up when its request reaches the transport, so a test can still swap one
 * or read the calls it recorded; it is called with the handler object as `this`.
 *
 * - A handler's value is answered 200 with that value as JSON; undefined is answered 204.
 * - An error carrying an HTTP status (400 to 599) is answered with that status and a
 *   Discord-shaped body ({ code, message }), as Discord would; any other error is thrown as
 *   a failure of the transport itself. A 429 also carries Retry-After and the X-RateLimit
 *   headers (its retryAfter in seconds, 1 by default), so discord.js waits before it sends
 *   an ordinary request again instead of repeating it at once.
 * - The request's abort signal is honoured: an aborted request rejects with an AbortError.
 *
 * Nothing here reaches the network. Every request runs through the REST's own queue, rate
 * limit, and retry handling, with retries 0 unless a test asks for more.
 */

const { REST } = require('@discordjs/rest');

const API_PREFIX = /^https:\/\/discord\.com\/api(?:\/v\d+)?/u;

function routeOf(url) {
  const relative = String(url).replace(API_PREFIX, '');
  const query = relative.indexOf('?');
  return query === -1 ? relative : relative.slice(0, query);
}

function bodyOf(init) {
  if (init?.body === undefined || init?.body === null) return null;
  const text = typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf8');
  return JSON.parse(text);
}

async function multipartOf(form) {
  const files = [];
  let body = null;
  for (const [key, value] of form.entries()) {
    if (key === 'payload_json') body = JSON.parse(String(value));
    else if (typeof value === 'object' && value !== null && typeof value.arrayBuffer === 'function') {
      files.push(Object.freeze({ key, name: value.name, type: value.type, data: Buffer.from(await value.arrayBuffer()) }));
    } else throw new Error(`Unexpected synthetic form field ${key}`);
  }
  return { body, files: Object.freeze(files) };
}

function answer(value) {
  if (value === undefined) return new Response(null, { status: 204 });
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function httpStatusOf(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

function refusal(error, status) {
  const code = Number.isSafeInteger(error?.code) ? error.code : 0;
  const message = String(error?.message || 'synthetic refusal');
  if (status !== 429) {
    return new Response(JSON.stringify({ code, message }), { status, headers: { 'content-type': 'application/json' } });
  }
  const retryAfter = Number.isFinite(error?.retryAfter) && error.retryAfter >= 0 ? error.retryAfter : 1;
  return new Response(JSON.stringify({ code, message, retry_after: retryAfter, global: false }), {
    status,
    headers: {
      'content-type': 'application/json',
      'retry-after': String(retryAfter),
      'x-ratelimit-limit': '1',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset-after': String(retryAfter),
      'x-ratelimit-scope': 'user',
    },
  });
}

function abortError() {
  return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

function createSyntheticRest(handlers = {}, { retries = 0, ...options } = {}) {
  const makeRequest = (url, init = {}) => new Promise((resolve, reject) => {
    const signal = init.signal;
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => reject(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    const method = String(init.method || 'GET').toLowerCase();
    const route = routeOf(url);
    Promise.resolve().then(() => {
      const handler = handlers?.[method];
      if (typeof handler !== 'function') throw new Error(`Unexpected synthetic ${method.toUpperCase()} ${route}`);
      if (init?.body instanceof FormData) return multipartOf(init.body).then((request) => handler.call(handlers, route, request));
      return handler.call(handlers, route, { body: bodyOf(init) });
    }).then((value) => resolve(answer(value)), (error) => {
      const status = httpStatusOf(error);
      if (status) resolve(refusal(error, status));
      else reject(error);
    }).finally(() => signal?.removeEventListener('abort', onAbort));
  });
  return new REST({ retries, ...options, makeRequest }).setToken('synthetic-token');
}

// Tests pass either a REST of their own (built with its own makeRequest) or a handler object.
function restFrom(value, options) {
  return value instanceof REST ? value : createSyntheticRest(value, options);
}

module.exports = { createSyntheticRest, restFrom };
