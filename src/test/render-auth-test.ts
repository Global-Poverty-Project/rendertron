'use strict';

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import request from 'supertest';
import test, { ExecutionContext } from 'ava';

import { Rendertron, parseBasicAuthHeader } from '../rendertron';
import { Config } from '../config';

const TARGET_PORT = 4101;
const FOREIGN_PORT = 4102;
const TARGET_ORIGIN = `http://127.0.0.1:${TARGET_PORT}`;
const FOREIGN_ORIGIN = `http://localhost:${FOREIGN_PORT}`;
const FAKE_USER = 'render-user';
const FAKE_PASSWORD = 'render-PW-fake-3f9a';
const FAKE_PAIR = `${FAKE_USER}:${FAKE_PASSWORD}`;
const FAKE_TOKEN = Buffer.from(FAKE_PAIR, 'utf8').toString('base64');
const BYPASS_COOKIE = 'bypass=fake-cookie-91d0';
const HEADER = 'X-Rendertron-Basic-Auth';
const INVALID_BODY = 'invalid X-Rendertron-Basic-Auth header';
const ORIGIN_BODY = 'X-Rendertron-Basic-Auth is not allowed for this origin';

type Recorded = { path: string; authorization: string | undefined };

const targetRequests: Recorded[] = [];
const foreignRequests: Recorded[] = [];
const capturedOutput: string[] = [];

const originalLog = console.log;
const originalError = console.error;
console.log = (...args: unknown[]) => {
  capturedOutput.push(args.map(String).join(' '));
  originalLog(...args);
};
console.error = (...args: unknown[]) => {
  capturedOutput.push(
    args
      .map((arg) => (arg instanceof Error ? `${arg.stack}` : String(arg)))
      .join(' ')
  );
  originalError(...args);
};

const PROTECTED_PAGE = `<!DOCTYPE html>
<html><head><title>protected-title</title>
<link rel="stylesheet" href="/a.css">
<link rel="stylesheet" href="${FOREIGN_ORIGIN}/b.css">
<script src="/a.js"></script>
<script src="${FOREIGN_ORIGIN}/b.js"></script>
</head><body>
<p>protected-content</p>
<img src="${FOREIGN_ORIGIN}/b.gif">
<iframe src="${FOREIGN_ORIGIN}/b-frame.html"></iframe>
<script>fetch('${FOREIGN_ORIGIN}/b-fetch.json').catch(function () {});</script>
</body></html>`;

const GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

function isAuthorized(req: http.IncomingMessage) {
  return (
    req.headers.authorization === `Basic ${FAKE_TOKEN}` ||
    (req.headers.cookie || '').includes(BYPASS_COOKIE)
  );
}

function deny(res: http.ServerResponse, realm: string) {
  res.writeHead(401, {
    'Content-Type': 'text/html',
    'WWW-Authenticate': `Basic realm="${realm}"`,
    'Access-Control-Allow-Origin': '*',
  });
  res.end('<html><body>denied</body></html>');
}

const targetServer = http.createServer((req, res) => {
  const reqPath = req.url || '';
  targetRequests.push({ path: reqPath, authorization: req.headers.authorization });
  if (reqPath === '/protected.html') {
    if (!isAuthorized(req)) {
      deny(res, 'target');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Set-Cookie': `${BYPASS_COOKIE}; Max-Age=86400; HttpOnly; Path=/`,
    });
    res.end(PROTECTED_PAGE);
    return;
  }
  if (reqPath === '/redirect.html') {
    if (!isAuthorized(req)) {
      deny(res, 'target');
      return;
    }
    res.writeHead(302, { Location: `${FOREIGN_ORIGIN}/landing.html` });
    res.end();
    return;
  }
  if (reqPath === '/a.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end('p { color: black; }');
    return;
  }
  if (reqPath === '/a.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end('window.targetScript = true;');
    return;
  }
  res.writeHead(404);
  res.end();
});

const foreignServer = http.createServer((req, res) => {
  const reqPath = req.url || '';
  foreignRequests.push({
    path: reqPath,
    authorization: req.headers.authorization,
  });
  if (reqPath === '/b.gif') {
    res.writeHead(200, { 'Content-Type': 'image/gif' });
    res.end(GIF);
    return;
  }
  deny(res, 'foreign');
});

function baseConfig(port: number): Config {
  return {
    cache: null,
    cacheConfig: {
      snapshotDir: path.join(os.tmpdir(), 'rendertron-auth-unused'),
      cacheDurationMinutes: '120',
      cacheMaxEntries: '50',
    },
    timeout: 10000,
    port: String(port),
    host: '127.0.0.1',
    width: 1000,
    height: 1000,
    reqHeaders: {},
    headers: {},
    puppeteerArgs: ['--no-sandbox'],
    renderOnly: [],
    closeBrowser: false,
    restrictedUrlPattern: null,
  };
}

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rendertron-auth-'));

let gateOff: request.SuperTest<request.Test>;
let gateOn: request.SuperTest<request.Test>;
let gateOnCache: request.SuperTest<request.Test>;

async function startRendertron(origins: string | undefined, config: Config) {
  if (origins === undefined) {
    delete process.env.RENDER_BASIC_AUTH_ORIGINS;
  } else {
    process.env.RENDER_BASIC_AUTH_ORIGINS = origins;
  }
  const server = await new Rendertron().initialize(config);
  delete process.env.RENDER_BASIC_AUTH_ORIGINS;
  return request(server);
}

test.before(async () => {
  delete process.env.PORT;
  delete process.env.HOST;
  await new Promise<void>((resolve) =>
    targetServer.listen(TARGET_PORT, '127.0.0.1', resolve)
  );
  await new Promise<void>((resolve) =>
    foreignServer.listen(FOREIGN_PORT, resolve)
  );
  gateOff = await startRendertron(undefined, baseConfig(4111));
  gateOn = await startRendertron(
    `${TARGET_ORIGIN}, not-an-origin`,
    baseConfig(4112)
  );
  gateOnCache = await startRendertron(TARGET_ORIGIN, {
    ...baseConfig(4113),
    cache: 'filesystem',
    cacheConfig: {
      snapshotDir: cacheDir,
      cacheDurationMinutes: '120',
      cacheMaxEntries: '50',
    },
  });
});

test.beforeEach(() => {
  targetRequests.length = 0;
  foreignRequests.length = 0;
});

function foreignPaths() {
  return foreignRequests.map((r) => r.path);
}

function headerValues(count: number, extra: string) {
  return Buffer.from(`${FAKE_USER}:${extra.repeat(count)}`).toString('base64');
}

test.serial(
  '1 gate unset: a valid header gives no credential to the target',
  async (t: ExecutionContext) => {
    const res = await gateOff
      .get(`/render/${TARGET_ORIGIN}/protected.html`)
      .set(HEADER, FAKE_TOKEN);
    t.is(res.status, 401);
    t.true(targetRequests.length > 0);
    t.true(targetRequests.every((r) => r.authorization === undefined));
  }
);

test.serial(
  '2 gate set, no header: the render stays anonymous',
  async (t: ExecutionContext) => {
    const res = await gateOn.get(`/render/${TARGET_ORIGIN}/protected.html`);
    t.is(res.status, 401);
    t.true(targetRequests.length > 0);
    t.true(targetRequests.every((r) => r.authorization === undefined));
  }
);

test.serial(
  '3 gate set, valid header: only target-origin requests get the credential',
  async (t: ExecutionContext) => {
    const res = await gateOn
      .get(`/render/${TARGET_ORIGIN}/protected.html`)
      .set(HEADER, FAKE_TOKEN);
    t.is(res.status, 200);
    t.true(res.text.includes('protected-content'));
    const targetPaths = targetRequests.map((r) => r.path);
    for (const expected of ['/protected.html', '/a.css', '/a.js']) {
      t.true(targetPaths.includes(expected), `target got ${expected}`);
    }
    t.true(
      targetRequests.every((r) => r.authorization === `Basic ${FAKE_TOKEN}`)
    );
    const paths = foreignPaths();
    for (const expected of [
      '/b.gif',
      '/b.js',
      '/b.css',
      '/b-frame.html',
      '/b-fetch.json',
    ]) {
      t.true(paths.includes(expected), `foreign got ${expected}`);
    }
    t.true(foreignRequests.every((r) => r.authorization === undefined));
  }
);

test.serial(
  '4 gate set, valid header: a redirect to a foreign origin is blocked',
  async (t: ExecutionContext) => {
    const res = await gateOn
      .get(`/render/${TARGET_ORIGIN}/redirect.html`)
      .set(HEADER, FAKE_TOKEN);
    t.not(res.status, 200);
    t.true(
      targetRequests.some(
        (r) =>
          r.path === '/redirect.html' &&
          r.authorization === `Basic ${FAKE_TOKEN}`
      )
    );
    t.true(foreignRequests.every((r) => r.authorization === undefined));
  }
);

test.serial(
  '5 gate set, invalid header values give 400 and no target request',
  async (t: ExecutionContext) => {
    const invalidValues = [
      'abc$def!',
      'dXNlcjpwYR==',
      Buffer.from('userpassword').toString('base64'),
      Buffer.from('user:pa\u0001ss').toString('base64'),
      headerValues(800, 'x'),
    ];
    t.true(invalidValues[4].length > 1024);
    for (const value of invalidValues) {
      const res = await gateOn
        .get(`/render/${TARGET_ORIGIN}/protected.html`)
        .set(HEADER, value);
      t.is(res.status, 400);
      t.is(res.text, INVALID_BODY);
    }
    t.is(targetRequests.length, 0);
  }
);

test.serial(
  '6 gate set: a header for an origin not in the list gives 400',
  async (t: ExecutionContext) => {
    const res = await gateOn
      .get(`/render/${FOREIGN_ORIGIN}/landing.html`)
      .set(HEADER, FAKE_TOKEN);
    t.is(res.status, 400);
    t.is(res.text, ORIGIN_BODY);
    t.is(foreignRequests.length, 0);
  }
);

test.serial(
  '7 cookie isolation: an anonymous render after an authenticated render gets 401',
  async (t: ExecutionContext) => {
    const authenticated = await gateOn
      .get(`/render/${TARGET_ORIGIN}/protected.html`)
      .set(HEADER, FAKE_TOKEN);
    t.is(authenticated.status, 200);
    const anonymous = await gateOn.get(
      `/render/${TARGET_ORIGIN}/protected.html`
    );
    t.is(anonymous.status, 401);
    const last = targetRequests[targetRequests.length - 1];
    t.is(last.path, '/protected.html');
    t.is(last.authorization, undefined);
  }
);

test.serial(
  '9 the screenshot route ignores the header',
  async (t: ExecutionContext) => {
    await gateOn
      .get(`/screenshot/${TARGET_ORIGIN}/protected.html`)
      .set(HEADER, FAKE_TOKEN);
    t.true(targetRequests.length > 0);
    t.true(targetRequests.every((r) => r.authorization === undefined));
  }
);

test.serial(
  '10 an invalid origin entry is logged with no value',
  async (t: ExecutionContext) => {
    t.true(
      capturedOutput.includes(
        'ignoring an invalid origin in RENDER_BASIC_AUTH_ORIGINS'
      )
    );
    t.false(capturedOutput.some((line) => line.includes('not-an-origin')));
  }
);

test.serial(
  '11 parseBasicAuthHeader accepts only a valid token',
  async (t: ExecutionContext) => {
    t.is(parseBasicAuthHeader(FAKE_TOKEN), FAKE_TOKEN);
    t.is(parseBasicAuthHeader(''), null);
    t.is(parseBasicAuthHeader('dXNlcjpwYR=='), null);
    t.is(parseBasicAuthHeader(Buffer.from(':pw').toString('base64')), null);
    t.is(parseBasicAuthHeader(Buffer.from('u:\u007fp').toString('base64')), null);
  }
);

test.serial(
  '8 the cache file and the output contain no credential',
  async (t: ExecutionContext) => {
    const res = await gateOnCache
      .get(`/render/${TARGET_ORIGIN}/protected.html`)
      .set(HEADER, FAKE_TOKEN);
    t.is(res.status, 200);
    const files = fs.readdirSync(cacheDir).filter((n) => n.endsWith('.json'));
    t.is(files.length, 1);
    const content = fs.readFileSync(path.join(cacheDir, files[0]), 'utf8');
    t.true(content.includes('protected-content'));
    const secrets = [FAKE_TOKEN, FAKE_PASSWORD, FAKE_PAIR];
    for (const secret of secrets) {
      t.false(content.includes(secret));
      t.false(capturedOutput.some((line) => line.includes(secret)));
    }
    const cached = await gateOnCache.get(
      `/render/${TARGET_ORIGIN}/protected.html`
    );
    t.is(cached.status, 200);
    t.truthy(cached.header['x-rendertron-cached']);
  }
);

test.after.always(() => {
  targetServer.close();
  foreignServer.close();
  fs.rmSync(cacheDir, { recursive: true, force: true });
});
