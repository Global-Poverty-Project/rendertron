/*
 * Copyright 2020 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may
 not
 * use this file except in compliance with the License. You may obtain a copy
 of
 * the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 under
 * the License.
 */

'use strict';

import { createHash, randomBytes } from 'crypto';

import * as fs from 'fs';
import * as path from 'path';
import * as Koa from 'koa';
import { Config } from './config';

type CacheContent = {
  saved: Date;
  expires: Date;
  response: string;
  payload: string;
};

export type EvictionResult =
  | 'disabled'
  | 'below-limit'
  | 'locked'
  | 'evicted'
  | 'error';

type LockResult = 'acquired' | 'locked' | 'error';

type EntryStat = {
  name: string;
  mtime: number;
};

const EVICTION_INTERVAL_MS = 60000;
const EVICTION_LOW_WATER_RATIO = 0.9;
const EVICTION_LOCK_STALE_MS = 300000;
const TMP_FILE_STALE_MS = 600000;
const EVICTION_STAT_CONCURRENCY = 16;
const EVICTION_LOCK_FILE = '.evict.lock';

const errorCode = (err: unknown) =>
  (err as NodeJS.ErrnoException | undefined)?.code;

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
) {
  let next = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    runners.push(
      (async () => {
        while (next < items.length) {
          const item = items[next++];
          await worker(item);
        }
      })()
    );
  }
  await Promise.all(runners);
}

export class FilesystemCache {
  private config: Config;
  private cacheConfig: { [key: string]: string };
  private lastEvictionCheck = 0;
  private evictionRunning = false;

  constructor(config: Config) {
    this.config = config;
    this.cacheConfig = this.config.cacheConfig;
    fs.mkdirSync(this.cacheConfig.snapshotDir, { recursive: true });
  }

  hashCode = (s: string) => {
    const hash = 0;
    if (s.length === 0) return hash.toString();

    return createHash('md5').update(s).digest('hex');
  };

  getDir = (key: string) => {
    const dir = this.cacheConfig.snapshotDir;

    if (key) {
      return path.join(dir, key);
    }

    return dir;
  };

  async clearCache(key: string) {
    let cleanKey = key;
    if (!cleanKey.endsWith('.json')) {
      cleanKey += '.json';
    }
    const filePath = this.getDir(cleanKey);
    try {
      fs.unlinkSync(filePath);
      console.log(`deleting: ${filePath}`);
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') {
        console.error(`cannot delete ${filePath}: ${errorCode(err)}`);
      }
    }
  }

  clearAllCacheHandler() {
    return this.handleClearAllCacheRequest.bind(this);
  }

  private async handleClearAllCacheRequest(ctx: Koa.Context) {
    await this.clearAllCache();
    ctx.status = 200;
  }

  async clearAllCache(): Promise<void> {
    const dir = this.getDir('');
    let files: string[];
    try {
      files = await fs.promises.readdir(dir);
    } catch (err) {
      console.error(`cannot read cache dir ${dir}: ${errorCode(err)}`);
      return;
    }
    await Promise.all(
      files
        .filter((file) => file.endsWith('.json'))
        .map((file) => this.unlinkIgnoreMissing(path.join(dir, file)))
    );
  }

  private async unlinkIgnoreMissing(filePath: string): Promise<boolean> {
    try {
      await fs.promises.unlink(filePath);
      return true;
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') {
        console.error(`cannot delete ${filePath}: ${errorCode(err)}`);
      }
      return false;
    }
  }

  private scheduleEviction() {
    const now = Date.now();
    if (
      this.evictionRunning ||
      now - this.lastEvictionCheck < EVICTION_INTERVAL_MS
    ) {
      return;
    }
    this.lastEvictionCheck = now;
    this.evictionRunning = true;
    this.evictIfNeeded().then(
      () => {
        this.evictionRunning = false;
      },
      () => {
        this.evictionRunning = false;
      }
    );
  }

  private async acquireEvictionLock(): Promise<LockResult> {
    const lockPath = this.getDir(EVICTION_LOCK_FILE);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await fs.promises.open(lockPath, 'wx');
        try {
          await handle.close();
        } catch (err) {
          console.error(`cannot close ${lockPath}: ${errorCode(err)}`);
        }
        return 'acquired';
      } catch (err) {
        if (errorCode(err) !== 'EEXIST') {
          console.error(`cannot create ${lockPath}: ${errorCode(err)}`);
          return 'error';
        }
      }
      if (attempt > 0) {
        return 'locked';
      }
      try {
        const stats = await fs.promises.stat(lockPath);
        if (Date.now() - stats.mtime.getTime() <= EVICTION_LOCK_STALE_MS) {
          return 'locked';
        }
      } catch (err) {
        if (errorCode(err) !== 'ENOENT') {
          console.error(`cannot stat ${lockPath}: ${errorCode(err)}`);
          return 'error';
        }
        continue;
      }
      console.log(`removing stale eviction lock: ${lockPath}`);
      await this.unlinkIgnoreMissing(lockPath);
    }
    return 'locked';
  }

  private async removeOldEntries(names: string[], maxEntries: number) {
    const dir = this.getDir('');
    const entries: EntryStat[] = [];
    const staleTmpFiles: string[] = [];
    const now = Date.now();

    await runWithConcurrency(names, EVICTION_STAT_CONCURRENCY, async (name) => {
      try {
        const stats = await fs.promises.stat(path.join(dir, name));
        const mtime = stats.mtime.getTime();
        if (name.endsWith('.json')) {
          entries.push({ name, mtime });
        } else if (now - mtime > TMP_FILE_STALE_MS) {
          staleTmpFiles.push(name);
        }
      } catch (err) {
        if (errorCode(err) !== 'ENOENT') {
          console.error(`cannot stat ${name}: ${errorCode(err)}`);
        }
      }
    });

    const target = Math.floor(maxEntries * EVICTION_LOW_WATER_RATIO);
    entries.sort((a, b) => a.mtime - b.mtime);
    const toRemove = entries
      .slice(0, Math.max(0, entries.length - target))
      .map((entry) => entry.name)
      .concat(staleTmpFiles);

    let removed = 0;
    await runWithConcurrency(
      toRemove,
      EVICTION_STAT_CONCURRENCY,
      async (name) => {
        if (await this.unlinkIgnoreMissing(path.join(dir, name))) {
          removed++;
        }
      }
    );
    console.log(
      `max cache entries reached - removed ${removed} files from ${dir}`
    );
  }

  async evictIfNeeded(): Promise<EvictionResult> {
    const maxEntries = parseInt(this.cacheConfig.cacheMaxEntries);
    if (maxEntries === -1 || isNaN(maxEntries)) {
      return 'disabled';
    }
    const dir = this.getDir('');
    try {
      const names = await fs.promises.readdir(dir);
      const count = names.filter((name) => name.endsWith('.json')).length;
      if (count <= maxEntries) {
        return 'below-limit';
      }

      const lock = await this.acquireEvictionLock();
      if (lock !== 'acquired') {
        return lock;
      }
      try {
        await this.removeOldEntries(
          names.filter(
            (name) => name.endsWith('.json') || name.endsWith('.tmp')
          ),
          maxEntries
        );
      } finally {
        await this.unlinkIgnoreMissing(this.getDir(EVICTION_LOCK_FILE));
      }
      return 'evicted';
    } catch (err) {
      console.error(`cache eviction failed in ${dir}: ${errorCode(err)}`);
      return 'error';
    }
  }

  async cacheContent(key: string, ctx: Koa.Context): Promise<void> {
    const responseHeaders = ctx.response;
    const responseBody = ctx.body;
    const filePath = this.getDir(key + '.json');
    const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString(
      'hex'
    )}.tmp`;
    try {
      const data = JSON.stringify({ responseBody, responseHeaders });
      await fs.promises.writeFile(tmpPath, data);
      await fs.promises.rename(tmpPath, filePath);
    } catch (err) {
      console.error(`cannot write cache file ${filePath}: ${errorCode(err)}`);
      await fs.promises.unlink(tmpPath).catch(() => undefined);
      return;
    }
    this.scheduleEviction();
  }

  getCachedContent(ctx: Koa.Context, key: string): CacheContent | null {
    if (ctx.query.refreshCache) {
      return null;
    } else {
      let fd: number | undefined;
      const filePath = this.getDir(key + '.json');
      try {
        fd = fs.openSync(filePath, 'r');
        const stats = fs.fstatSync(fd);
        const cacheFile = JSON.parse(fs.readFileSync(fd, 'utf8'));
        const payload = cacheFile.responseBody;
        const response = JSON.stringify(cacheFile.responseHeaders);
        if (!payload) {
          return null;
        }
        // use modification time as the saved time
        const saved = stats.mtime;
        const expires = new Date(
          saved.getTime() +
          parseInt(this.cacheConfig.cacheDurationMinutes) * 60 * 1000
        );
        return {
          saved,
          expires,
          payload,
          response,
        };
      } catch (err) {
        return null;
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch (err) {
            console.error(`cannot close cache file ${filePath}: ${errorCode(err)}`);
          }
        }
      }
    }
  }
  invalidateHandler() {
    return this.handleInvalidateRequest.bind(this);
  }

  sanitizeKey(key: string) {
    // Cache based on full URL. This means requests with different params are
    // cached separately (except for refreshCache parameter
    let cacheKey = key.replace(/&?refreshCache=(?:true|false)&?/i, '');

    if (cacheKey.charAt(cacheKey.length - 1) === '?') {
      cacheKey = cacheKey.slice(0, -1);
    }

    // remove /render/ from key, only at the start
    if (cacheKey.startsWith('/render/')) {
      cacheKey = cacheKey.substring(8);
    }

    // remove trailing slash from key
    cacheKey = cacheKey.replace(/\/$/, '');
    return cacheKey
  }

  private async handleInvalidateRequest(ctx: Koa.Context, url: string) {
    let cacheKey = this.sanitizeKey(url);

    // remove /invalidate/ from key, only at the start
    if (cacheKey.startsWith('/invalidate/')) {
      cacheKey = cacheKey.substring(12);
    }

    // key is hashed crudely
    const key = this.hashCode(cacheKey);
    this.clearCache(key);
    ctx.status = 200;
  }



  /**
   * Returns middleware function.
   */
  middleware() {
    const cacheContent = this.cacheContent.bind(this);

    return async function (
      this: FilesystemCache,
      ctx: Koa.Context,
      next: () => Promise<unknown>
    ) {

      const cacheKey = this.sanitizeKey(ctx.url);
      // key is hashed crudely
      const key = this.hashCode(cacheKey);
      const content = await this.getCachedContent(ctx, key);
      if (content) {
        // Serve cached content if its not expired.
        if (
          content.expires.getTime() >= new Date().getTime() ||
          parseInt(this.config.cacheConfig.cacheDurationMinutes) === -1
        ) {
          const response = JSON.parse(content.response);
          ctx.set(response.header);
          ctx.set('x-rendertron-cached', content.saved.toUTCString());
          ctx.status = response.status;
          let payload: string | { type?: string } = content.payload;
          try {
            payload = JSON.parse(content.payload);
          } catch (e) {
            // swallow this.
          }
          try {
            if (
              payload &&
              typeof payload === 'object' &&
              payload.type === 'Buffer'
            ) {
              ctx.body = Buffer.from(payload);
            } else {
              ctx.body = payload;
            }
            return;
          } catch (error) {
            console.log(
              'Erroring parsing cache contents, falling back to normal render'
            );
          }
        }
      }

      await next();

      if (ctx.status === 200) {
        await cacheContent(key, ctx);
      }
    }.bind(this);
  }
}
