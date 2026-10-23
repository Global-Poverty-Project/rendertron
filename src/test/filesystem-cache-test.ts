/*
 * Copyright 2020 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

'use strict';

import fs from 'fs';
import os from 'os';
import path from 'path';
import Koa from 'koa';
import koaCompress from 'koa-compress';
import request from 'supertest';
import route from 'koa-route';

import { FilesystemCache } from '../filesystem-cache';
import { ConfigManager } from '../config';
import test, { ExecutionContext } from 'ava';

const config = ConfigManager.config;
const app = new Koa();
const server = request(app.listen());
const cache = new FilesystemCache(config);

app.use(route.get('/compressed', koaCompress()));

app.use(cache.middleware());

let handlerCalledCount = 0;

test.before(async () => {
  await cache.clearAllCache();
});

app.use(
  route.get('/', (ctx: Koa.Context) => {
    handlerCalledCount++;
    ctx.body = `Called ${handlerCalledCount} times`;
  })
);

const promiseTimeout = function (timeout: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, timeout);
  });
};

test('caches content and serves same content on cache hit', async (t: ExecutionContext) => {
  const previousCount = handlerCalledCount;
  let res = await server.get('/?basictest');
  t.is(res.status, 200);
  t.is(res.text, 'Called ' + (previousCount + 1) + ' times');

  // Workaround for race condition with writing to datastore.
  await promiseTimeout(2000);

  res = await server.get('/?basictest');
  t.is(res.status, 200);
  t.is(res.text, 'Called ' + (previousCount + 1) + ' times');
  t.truthy(res.header['x-rendertron-cached']);
  t.true(new Date(res.header['x-rendertron-cached']) <= new Date());

  res = await server.get('/?basictest');
  t.is(res.status, 200);
  t.is(res.text, 'Called ' + (previousCount + 1) + ' times');
});

app.use(
  route.get('/set-header', (ctx: Koa.Context) => {
    ctx.set('my-header', 'header-value');
    ctx.body = 'set-header-payload';
  })
);

test('caches headers', async (t: ExecutionContext) => {
  let res = await server.get('/set-header');
  t.is(res.status, 200);
  t.is(res.header['my-header'], 'header-value');
  t.is(res.text, 'set-header-payload');

  // Workaround for race condition with writing to datastore.
  await promiseTimeout(500);

  res = await server.get('/set-header');
  t.is(res.status, 200);
  t.is(res.header['my-header'], 'header-value');
  t.is(res.text, 'set-header-payload');
});

app.use(
  route.get('/compressed', (ctx: Koa.Context) => {
    ctx.set('Content-Type', 'text/html');
    ctx.body = new Array(1025).join('x');
  })
);

test('compression preserved', async (t: ExecutionContext) => {
  const expectedBody = new Array(1025).join('x');
  let res = await server
    .get('/compressed')
    .set('Accept-Encoding', 'gzip, deflate');
  t.is(res.status, 200);
  t.is(res.header['content-encoding'], 'gzip');
  t.is(res.text, expectedBody);

  // Workaround for race condition with writing to datastore.
  await promiseTimeout(500);

  res = await server.get('/compressed').set('Accept-Encoding', 'gzip, deflate');
  t.is(res.status, 200);
  t.is(res.header['content-encoding'], 'gzip');
  t.is(res.text, expectedBody);
});

let statusCallCount = 0;
app.use(
  route.get('/status/:status', (ctx: Koa.Context, status: string) => {
    // Every second call sends a different status.
    if (statusCallCount % 2 === 0) {
      ctx.status = Number(status);
    } else {
      ctx.status = 401;
    }
    statusCallCount++;
  })
);

test('original status is preserved', async (t: ExecutionContext) => {
  let res = await server.get('/status/400');
  t.is(res.status, 400);

  // Non 200 status code should not be cached.
  res = await server.get('/status/400');
  t.is(res.status, 401);
});

test('cache entry can be removed', async (t: ExecutionContext) => {
  let res = await server.get('/?cacheremovetest');
  t.is(res.status, 200);
  t.falsy(res.header['x-rendertron-cached']);
  t.false(new Date(res.header['x-rendertron-cached']) <= new Date());

  res = await server.get('/?cacheremovetest');
  t.is(res.status, 200);
  t.truthy(res.header['x-rendertron-cached']);
  t.true(new Date(res.header['x-rendertron-cached']) <= new Date());
  const key = cache.hashCode('/?cacheremovetest');
  cache.clearCache(key);
  res = await server.get('/?cacheremovetest');
  t.is(res.status, 200);
  t.falsy(res.header['x-rendertron-cached']);
  t.false(new Date(res.header['x-rendertron-cached']) <= new Date());

  res = await server.get('/?cacheremovetest');
  t.is(res.status, 200);
  t.truthy(res.header['x-rendertron-cached']);
  t.true(new Date(res.header['x-rendertron-cached']) <= new Date());
});

test('refreshCache refreshes cache', async (t: ExecutionContext) => {
  let content = 'content';
  app.use(
    route.get('/refreshTest', (ctx: Koa.Context) => {
      ctx.body = content;
    })
  );

  let res = await server.get('/refreshTest');
  t.is(res.status, 200);
  t.is(res.text, 'content');

  // Workaround for race condition with writing to datastore.
  await promiseTimeout(500);

  res = await server.get('/refreshTest');
  t.truthy(res.header['x-rendertron-cached']);
  t.is(res.text, 'content');

  content = 'updated content';

  res = await server.get('/refreshTest?refreshCache=true');
  t.is(res.status, 200);
  t.is(res.text, 'updated content');
  t.is(res.header['x-rendertron-cached'], undefined);
});

test.serial(
  'clear all filesystem cache entries',
  async (t: ExecutionContext) => {
    app.use(
      route.get('/clear-all-cache', (ctx: Koa.Context) => {
        ctx.body = 'Foo';
      })
    );

    await server.get('/clear-all-cache?cachedResult1');
    await server.get('/clear-all-cache?cachedResult2');

    let res = await server.get('/clear-all-cache?cachedResult1');
    t.is(res.status, 200);
    t.truthy(res.header['x-rendertron-cached']);
    t.true(new Date(res.header['x-rendertron-cached']) <= new Date());
    res = await server.get('/clear-all-cache?cachedResult2');
    t.is(res.status, 200);
    t.truthy(res.header['x-rendertron-cached']);
    t.true(new Date(res.header['x-rendertron-cached']) <= new Date());

    cache.clearAllCache();
    await promiseTimeout(500);
    res = await server.get('/clear-all-cache?cachedResult1');
    t.is(res.status, 200);
    t.falsy(res.header['x-rendertron-cached']);
    t.false(new Date(res.header['x-rendertron-cached']) <= new Date());
    res = await server.get('/clear-all-cache?cachedResult2');
    t.is(res.status, 200);
    t.falsy(res.header['x-rendertron-cached']);
    t.false(new Date(res.header['x-rendertron-cached']) <= new Date());
  }
);

const testDirs: string[] = [];

function makeCache(maxEntries = '100') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rendertron-test-'));
  testDirs.push(dir);
  const testConfig = {
    ...config,
    cacheConfig: {
      ...config.cacheConfig,
      snapshotDir: dir,
      cacheMaxEntries: maxEntries,
    },
  };
  return { cache: new FilesystemCache(testConfig), dir };
}

function fakeContext(body: string): Koa.Context {
  return ({
    body,
    response: { status: 200, header: {} },
    request: { url: '/' },
    query: {},
  } as unknown) as Koa.Context;
}

function filesWithSuffix(dir: string, suffix: string) {
  return fs.readdirSync(dir).filter((name) => name.endsWith(suffix));
}

function secondsAgo(seconds: number) {
  return Date.now() / 1000 - seconds;
}

function writeEntries(dir: string, count: number) {
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `entry-${String(i).padStart(2, '0')}.json`;
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, JSON.stringify({ responseBody: name }));
    const mtime = secondsAgo(1000 - i);
    fs.utimesSync(filePath, mtime, mtime);
    names.push(name);
  }
  return names;
}

test.after.always(() => {
  for (const dir of testDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic write leaves no temporary files', async (t: ExecutionContext) => {
  const { cache: testCache, dir } = makeCache();
  await testCache.cacheContent('atomic', fakeContext('atomic body'));
  const jsonFiles = filesWithSuffix(dir, '.json');
  t.is(jsonFiles.length, 1);
  t.is(filesWithSuffix(dir, '.tmp').length, 0);
  const parsed = JSON.parse(
    fs.readFileSync(path.join(dir, jsonFiles[0]), 'utf8')
  );
  t.is(parsed.responseBody, 'atomic body');
  t.is(parsed.request, undefined);
});

test('concurrent writes of one key never give a partial read', async (t: ExecutionContext) => {
  const { cache: testCache } = makeCache();
  const key = testCache.hashCode('/concurrent');
  const minSize = 1024;
  const maxSize = 2 * 1024 * 1024;
  const bodies = Array.from({ length: 20 }, (_, i) =>
    String.fromCharCode(97 + i).repeat(
      minSize + Math.floor((i * (maxSize - minSize)) / 19)
    )
  );
  const writes = bodies.map((body) =>
    testCache.cacheContent(key, fakeContext(body))
  );
  let badReads = 0;
  for (let i = 0; i < 50; i++) {
    const content = testCache.getCachedContent(fakeContext(''), key);
    if (content !== null && !bodies.includes(content.payload)) {
      badReads++;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(writes);
  t.is(badReads, 0);
  const last = testCache.getCachedContent(fakeContext(''), key);
  t.truthy(last);
  t.true(bodies.includes(last ? last.payload : ''));
});

test('clearCache ignores a missing file', async (t: ExecutionContext) => {
  const { cache: testCache } = makeCache();
  await t.notThrowsAsync(testCache.clearCache('does-not-exist'));
});

test('clearAllCache survives concurrent removal', async (t: ExecutionContext) => {
  const { cache: testCache, dir } = makeCache();
  for (let i = 0; i < 20; i++) {
    await testCache.cacheContent(`key-${i}`, fakeContext(`body ${i}`));
  }
  t.is(filesWithSuffix(dir, '.json').length, 20);
  let uncaught = 0;
  const listener = () => {
    uncaught++;
  };
  process.on('uncaughtException', listener);
  try {
    await t.notThrowsAsync(
      Promise.all([
        testCache.clearAllCache(),
        testCache.clearAllCache(),
        testCache.clearAllCache(),
      ])
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    process.removeListener('uncaughtException', listener);
  }
  t.is(filesWithSuffix(dir, '.json').length, 0);
  t.is(uncaught, 0);
});

test('clearAllCache resolves when readdir fails', async (t: ExecutionContext) => {
  const { cache: testCache, dir } = makeCache();
  fs.rmdirSync(dir);
  fs.writeFileSync(dir, 'not a directory');
  await t.notThrowsAsync(testCache.clearAllCache());
});

test('eviction trims to 90 percent of maxEntries', async (t: ExecutionContext) => {
  const { cache: testCache, dir } = makeCache('10');
  const names = writeEntries(dir, 15);
  t.is(await testCache.evictIfNeeded(), 'evicted');
  const remaining = filesWithSuffix(dir, '.json').sort();
  t.is(remaining.length, 9);
  t.deepEqual(remaining, names.slice(6));
});

test('eviction skips below the limit', async (t: ExecutionContext) => {
  const { cache: testCache, dir } = makeCache('10');
  writeEntries(dir, 5);
  t.is(await testCache.evictIfNeeded(), 'below-limit');
  t.is(filesWithSuffix(dir, '.json').length, 5);
});

test('eviction honors a fresh lock and takes a stale lock', async (t: ExecutionContext) => {
  const { cache: testCache, dir } = makeCache('10');
  writeEntries(dir, 15);
  const lockPath = path.join(dir, '.evict.lock');
  fs.writeFileSync(lockPath, '');
  t.is(await testCache.evictIfNeeded(), 'locked');
  t.is(filesWithSuffix(dir, '.json').length, 15);
  const old = secondsAgo(400);
  fs.utimesSync(lockPath, old, old);
  t.is(await testCache.evictIfNeeded(), 'evicted');
  t.false(fs.readdirSync(dir).includes('.evict.lock'));
  t.is(filesWithSuffix(dir, '.json').length, 9);
});

test('eviction removes stale temporary files', async (t: ExecutionContext) => {
  const { cache: testCache, dir } = makeCache('10');
  writeEntries(dir, 15);
  const staleTmp = path.join(dir, 'stale.json.1.deadbeef.tmp');
  const freshTmp = path.join(dir, 'fresh.json.1.cafebabe.tmp');
  fs.writeFileSync(staleTmp, 'partial');
  fs.writeFileSync(freshTmp, 'partial');
  const staleTime = secondsAgo(700);
  const freshTime = secondsAgo(10);
  fs.utimesSync(staleTmp, staleTime, staleTime);
  fs.utimesSync(freshTmp, freshTime, freshTime);
  t.is(await testCache.evictIfNeeded(), 'evicted');
  const tmpFiles = filesWithSuffix(dir, '.tmp');
  t.false(tmpFiles.includes(path.basename(staleTmp)));
  t.true(tmpFiles.includes(path.basename(freshTmp)));
});

test.serial(
  'cache write does not stat every entry',
  async (t: ExecutionContext) => {
    const { cache: testCache, dir } = makeCache('10');
    writeEntries(dir, 50);
    const mutableFs = (fs as unknown) as {
      statSync: (...args: unknown[]) => unknown;
    };
    const mutablePromises = (fs.promises as unknown) as {
      stat: (...args: unknown[]) => Promise<unknown>;
    };
    const realStatSync = mutableFs.statSync;
    const realStat = mutablePromises.stat;
    let statSyncCalls = 0;
    let statCalls = 0;
    mutableFs.statSync = (...args: unknown[]) => {
      statSyncCalls++;
      return realStatSync.apply(fs, args);
    };
    mutablePromises.stat = (...args: unknown[]) => {
      statCalls++;
      return realStat.apply(fs.promises, args);
    };
    let callsAtResolve: number[];
    try {
      await testCache.cacheContent('no-stat', fakeContext('body'));
      callsAtResolve = [statSyncCalls, statCalls];
    } finally {
      mutableFs.statSync = realStatSync;
      mutablePromises.stat = realStat;
    }
    t.deepEqual(callsAtResolve, [0, 0]);
  }
);
