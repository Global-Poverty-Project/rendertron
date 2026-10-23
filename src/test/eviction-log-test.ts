'use strict';

import fs from 'fs';
import os from 'os';
import path from 'path';
import test, { ExecutionContext } from 'ava';

import { FilesystemCache } from '../filesystem-cache';
import { ConfigManager } from '../config';

const config = ConfigManager.config;
const testDirs: string[] = [];

function makeCache(maxEntries: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rendertron-evict-log-'));
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

function secondsAgo(seconds: number) {
  return Date.now() / 1000 - seconds;
}

function writeEntries(dir: string, count: number) {
  for (let i = 0; i < count; i++) {
    const filePath = path.join(dir, `entry-${String(i).padStart(2, '0')}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ responseBody: String(i) }));
    const mtime = secondsAgo(1000 - i);
    fs.utimesSync(filePath, mtime, mtime);
  }
}

async function captureLogs(action: () => Promise<unknown>) {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    const result = await action();
    return { result, lines };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test.serial(
  'eviction logs the needed, scan and removed lines over the limit',
  async (t: ExecutionContext) => {
    const { cache, dir } = makeCache('10');
    writeEntries(dir, 15);
    const { result, lines } = await captureLogs(() => cache.evictIfNeeded());
    t.is(result, 'evicted');
    t.deepEqual(lines, [
      `cache eviction needed in ${dir}: 15 entries, limit 10`,
      `cache eviction scan in ${dir}: 15 entries, 0 temporary files, 0 stale temporary files, target 9`,
      `max cache entries reached - removed 6 files from ${dir}`,
    ]);
  }
);

test.serial(
  'eviction logs nothing below the limit',
  async (t: ExecutionContext) => {
    const { cache, dir } = makeCache('10');
    writeEntries(dir, 10);
    const { result, lines } = await captureLogs(() => cache.evictIfNeeded());
    t.is(result, 'below-limit');
    t.deepEqual(lines, []);
  }
);

test.serial(
  'eviction logs the skipped line when a fresh lock exists',
  async (t: ExecutionContext) => {
    const { cache, dir } = makeCache('10');
    writeEntries(dir, 15);
    fs.writeFileSync(path.join(dir, '.evict.lock'), '');
    const { result, lines } = await captureLogs(() => cache.evictIfNeeded());
    t.is(result, 'locked');
    t.deepEqual(lines, [
      `cache eviction needed in ${dir}: 15 entries, limit 10`,
      `cache eviction skipped in ${dir}: lock held`,
    ]);
    t.is(fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length, 15);
  }
);

test.serial(
  'eviction scan counts fresh and stale temporary files',
  async (t: ExecutionContext) => {
    const { cache, dir } = makeCache('10');
    writeEntries(dir, 15);
    const staleTmp = path.join(dir, 'stale.json.1.deadbeef.tmp');
    const freshTmp = path.join(dir, 'fresh.json.1.cafebabe.tmp');
    fs.writeFileSync(staleTmp, 'partial');
    fs.writeFileSync(freshTmp, 'partial');
    const staleTime = secondsAgo(700);
    const freshTime = secondsAgo(10);
    fs.utimesSync(staleTmp, staleTime, staleTime);
    fs.utimesSync(freshTmp, freshTime, freshTime);
    const { result, lines } = await captureLogs(() => cache.evictIfNeeded());
    t.is(result, 'evicted');
    t.deepEqual(lines, [
      `cache eviction needed in ${dir}: 15 entries, limit 10`,
      `cache eviction scan in ${dir}: 15 entries, 2 temporary files, 1 stale temporary files, target 9`,
      `max cache entries reached - removed 7 files from ${dir}`,
    ]);
    const remaining = fs.readdirSync(dir);
    t.false(remaining.includes(path.basename(staleTmp)));
    t.true(remaining.includes(path.basename(freshTmp)));
  }
);

test.serial(
  'eviction log values match the removed count rule',
  async (t: ExecutionContext) => {
    const { cache, dir } = makeCache('20');
    writeEntries(dir, 21);
    const { lines } = await captureLogs(() => cache.evictIfNeeded());
    const scan = lines[1].match(
      /^cache eviction scan in \S+: (\d+) entries, (\d+) temporary files, (\d+) stale temporary files, target (\d+)$/
    );
    const removed = lines[2].match(
      /^max cache entries reached - removed (\d+) files from \S+$/
    );
    t.truthy(scan);
    t.truthy(removed);
    if (scan && removed) {
      const n = Number(scan[1]);
      const s = Number(scan[3]);
      const target = Number(scan[4]);
      t.is(target, 18);
      t.is(Number(removed[1]), Math.max(0, n - target) + s);
    }
  }
);

test.after.always(() => {
  for (const dir of testDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
