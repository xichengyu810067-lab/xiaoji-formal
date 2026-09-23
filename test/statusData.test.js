const test = require('node:test');
const assert = require('node:assert/strict');
const { createStatusLoader } = require('../website/statusData');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(payload) {
  return { ok: true, json: async () => payload };
}

test('a stale successful response cannot overwrite a newer status snapshot', async () => {
  const first = deferred();
  const second = deferred();
  const renders = [];
  const loading = [];
  let requestCount = 0;
  const loader = createStatusLoader({
    fetchImpl: () => (requestCount++ === 0 ? first.promise : second.promise),
    urlProvider: () => '/api/public/status',
    renderSuccess: (payload) => renders.push(payload.id),
    renderFailure: () => renders.push('failure'),
    setLoading: (value) => loading.push(value),
  });

  const olderRequest = loader.refresh();
  const newerRequest = loader.refresh();
  second.resolve(response({ id: 'newer' }));
  await newerRequest;
  first.resolve(response({ id: 'older' }));

  assert.deepEqual(await olderRequest, { stale: true });
  assert.deepEqual(renders, ['newer']);
  assert.deepEqual(loading, [true, true, false]);
});

test('a stale failed response cannot replace a newer successful snapshot', async () => {
  const first = deferred();
  const second = deferred();
  const renders = [];
  let requestCount = 0;
  const loader = createStatusLoader({
    fetchImpl: () => (requestCount++ === 0 ? first.promise : second.promise),
    urlProvider: () => '/api/public/status',
    renderSuccess: (payload) => renders.push(payload.id),
    renderFailure: () => renders.push('failure'),
    setLoading() {},
  });

  const olderRequest = loader.refresh();
  const newerRequest = loader.refresh();
  second.resolve(response({ id: 'newer' }));
  await newerRequest;
  first.reject(new Error('late failure'));

  assert.deepEqual(await olderRequest, { stale: true });
  assert.deepEqual(renders, ['newer']);
});
