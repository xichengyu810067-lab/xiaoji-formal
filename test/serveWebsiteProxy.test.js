const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const cp = require('node:child_process');

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function makeRequest({ host, port, method, path }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port,
      method,
      path,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => {
        chunks.push(chunk);
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForPreviewServerReady(websiteProcess, port, timeoutMs = 1500) {
  let processError;
  const onError = (error) => {
    processError = error;
  };
  websiteProcess.once('error', onError);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (websiteProcess.exitCode !== null || processError) {
        throw new Error(processError?.message || 'website preview server exited before ready');
      }

      await makeRequest({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: '/api/public/overview',
      });
      return;
    } catch (_error) {
      await sleep(25);
    }
  }

  websiteProcess.off('error', onError);
  throw new Error('website preview server did not become ready in time');
}

function closeStatusServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function closeWebsiteProcess(serverProcess) {
  if (!serverProcess || serverProcess.killed || serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
    return;
  }

  serverProcess.kill('SIGTERM');
  await once(serverProcess, 'exit');
}

test('serve-website proxies public status endpoints with exact route and method checks', async () => {
  const statusPort = await allocatePort();
  const websitePort = await allocatePort();

  const publicStatusCalls = [];
  const statusServer = http.createServer((request, response) => {
    publicStatusCalls.push({ method: request.method, url: request.url });

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end();
      return;
    }

    if (request.url === '/api/public/overview' || request.url === '/api/public/status') {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify({ endpoint: request.url }));
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve, reject) => {
    statusServer.listen(statusPort, '127.0.0.1', resolve);
    statusServer.on('error', reject);
  });

  const websiteProcess = cp.spawn(process.execPath, ['scripts/serve-website.js'], {
    env: {
      ...process.env,
      WEBSITE_PORT: String(websitePort),
      PUBLIC_STATUS_PREVIEW_PORT: String(statusPort),
      GAME_PREVIEW_PORT: String(0),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  try {
    await waitForPreviewServerReady(websiteProcess, websitePort);
    publicStatusCalls.length = 0;

    const overviewGet = await makeRequest({
      host: '127.0.0.1',
      port: websitePort,
      method: 'GET',
      path: '/api/public/overview',
    });
    assert.equal(overviewGet.statusCode, 200);
    assert.equal(overviewGet.headers['cache-control'], 'no-store');
    assert.equal(overviewGet.body, JSON.stringify({ endpoint: '/api/public/overview' }));

    const statusHead = await makeRequest({
      host: '127.0.0.1',
      port: websitePort,
      method: 'HEAD',
      path: '/api/public/status',
    });
    assert.equal(statusHead.statusCode, 200);
    assert.equal(statusHead.body, '');

    const statusOptions = await makeRequest({
      host: '127.0.0.1',
      port: websitePort,
      method: 'OPTIONS',
      path: '/api/public/status',
    });
    assert.equal(statusOptions.statusCode, 204);

    const overviewPost = await makeRequest({
      host: '127.0.0.1',
      port: websitePort,
      method: 'POST',
      path: '/api/public/overview',
    });
    assert.equal(overviewPost.statusCode, 405);
    assert.equal(overviewPost.headers.allow, 'GET, HEAD, OPTIONS');

    const overviewQuery = await makeRequest({
      host: '127.0.0.1',
      port: websitePort,
      method: 'GET',
      path: '/api/public/overview?probe=true',
    });
    assert.equal(overviewQuery.statusCode, 404);

    const unknownPath = await makeRequest({
      host: '127.0.0.1',
      port: websitePort,
      method: 'GET',
      path: '/api/public/secret',
    });
    assert.equal(unknownPath.statusCode, 404);

    assert.deepEqual(publicStatusCalls, [
      { method: 'GET', url: '/api/public/overview' },
      { method: 'HEAD', url: '/api/public/status' },
      { method: 'OPTIONS', url: '/api/public/status' },
    ]);
  } finally {
    await closeWebsiteProcess(websiteProcess);
    await closeStatusServer(statusServer);
  }
});
