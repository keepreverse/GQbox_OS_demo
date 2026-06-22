import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { MarketplaceEntityCode } from '../types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CACHE_DIR = resolve(__dirname, '..', 'data', 'cache');

interface StoredEntry {
  nmId: number;
  periodKey: string;
  data: unknown;
  expiresAt: number;
}

interface CacheFile {
  version: 1;
  entries: StoredEntry[];
}

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function filePath(service: string, entity: MarketplaceEntityCode): string {
  return resolve(CACHE_DIR, `${service}-${entity}.json`);
}

function refreshTimestampPath(service: string, entity: MarketplaceEntityCode): string {
  return resolve(CACHE_DIR, `${service}-${entity}-refresh.json`);
}

export function saveRefreshTimestamp(service: string, entity: MarketplaceEntityCode): void {
  ensureCacheDir();
  const payload = { lastRefreshAt: Date.now() };
  const tmp = refreshTimestampPath(service, entity) + '.tmp';
  writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
  renameSync(tmp, refreshTimestampPath(service, entity));
}

export function deleteRefreshTimestamp(service: string, entity: MarketplaceEntityCode): void {
  const path = refreshTimestampPath(service, entity);
  try { if (existsSync(path)) renameSync(path, path + '.bak'); } catch { /* ignore */ }
}

export function deleteServiceCache(service: string, entity: MarketplaceEntityCode): void {
  const path = filePath(service, entity);
  try {
    if (existsSync(path)) {
      const bakPath = path + '.bak';
      if (existsSync(bakPath)) unlinkSync(bakPath);
      renameSync(path, bakPath);
    }
  } catch { /* ignore */ }
}

export function loadRefreshTimestamp(service: string, entity: MarketplaceEntityCode): number | null {
  const path = refreshTimestampPath(service, entity);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as { lastRefreshAt: number };
    return typeof parsed.lastRefreshAt === 'number' ? parsed.lastRefreshAt : null;
  } catch {
    return null;
  }
}

export function saveCache(
  service: string,
  entity: MarketplaceEntityCode,
  cache: Map<number, Map<string, { article: unknown; expiresAt: number }>>
): void {
  ensureCacheDir();
  const entries: StoredEntry[] = [];
  const now = Date.now();
  for (const [nmId, byPeriod] of cache) {
    for (const [periodKey, entry] of byPeriod) {
      if (entry.expiresAt > now) {
        entries.push({
          nmId,
          periodKey,
          data: entry.article,
          expiresAt: entry.expiresAt,
        });
      }
    }
  }
  const payload: CacheFile = { version: 1, entries };
  const tmp = filePath(service, entity) + '.tmp';
  writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
  renameSync(tmp, filePath(service, entity));
}

export function loadCache(
  service: string,
  entity: MarketplaceEntityCode,
  nmIds: number[]
): Map<number, Map<string, { article: unknown; expiresAt: number }>> {
  const path = filePath(service, entity);
  if (!existsSync(path)) return new Map();

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return new Map();
  }

  let parsed: CacheFile;
  try {
    parsed = JSON.parse(raw) as CacheFile;
  } catch {
    return new Map();
  }

  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return new Map();

  const now = Date.now();
  const validNmIds = new Set(nmIds);
  const cache = new Map<number, Map<string, { article: unknown; expiresAt: number }>>();
  const nmIdSet = new Set<number>();

  for (const entry of parsed.entries) {
    if (entry.expiresAt <= now) continue;
    if (!validNmIds.has(entry.nmId)) continue;

    let byPeriod = cache.get(entry.nmId);
    if (!byPeriod) {
      byPeriod = new Map();
      cache.set(entry.nmId, byPeriod);
      nmIdSet.add(entry.nmId);
    }
    if (!byPeriod.has(entry.periodKey)) {
      byPeriod.set(entry.periodKey, {
        article: entry.data,
        expiresAt: entry.expiresAt,
      });
    }
  }

  return cache;
}
