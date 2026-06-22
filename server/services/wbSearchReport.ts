// ─── WB Search Report Service (multi-entity) ──────────────────────────────
// Прокси к WB Search Report API (search-texts) с per-article кэшем,
// фоновым warmup-ом и rate limiter-ом. Аналогично wbAnalytics, но для
// поисковых запросов: text, openCard, frequency, avgPosition, visibility.
//
// **Multi-entity**: каждый кабинет (КЮА, КАА, ДЕВ, БМС) имеет свой токен,
// свой кэш, свой rate limiter (~1 мин/запрос). nmId→entity резолвится
// из products.json, после чего запрос маршрутизируется в сервис нужного
// кабинета.

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { RawProduct, MarketplaceEntityCode } from '../types';
import { saveCache, loadCache, saveRefreshTimestamp, loadRefreshTimestamp, deleteRefreshTimestamp, deleteServiceCache } from './cacheStore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WB_SEARCH_TEXTS_URL =
  'https://seller-analytics-api.wildberries.ru/api/v2/search-report/product/search-texts';
const WB_MAX_NMIDS_PER_REQUEST = 1000;
const MIN_INTERVAL_MS = 65_000;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_429_RETRIES = 3;
const WARMUP_LIMIT = 20;
const WARMUP_BATCH_SIZE = 5;
const SERVICE_NAME = 'wb-search-report';

// ─── Entity / token resolution ────────────────────────────────────────────

const ENTITY_ORDER: MarketplaceEntityCode[] = ['kua', 'kaa', 'dev'];

function getTokenForEntity(entity: MarketplaceEntityCode): string {
  const explicit = process.env[`WB_API_TOKEN_${entity.toUpperCase()}`];
  if (explicit) return explicit;
  if (entity === 'kua') return process.env.WB_API_TOKEN_KUA || '';
  return '';
}

function getConfiguredEntities(): MarketplaceEntityCode[] {
  return ENTITY_ORDER.filter((e) => getTokenForEntity(e) !== '');
}

// ─── Типы ответа WB (нормализованные) ──────────────────────────────────────

export interface WbSearchTextItem {
  text: string;
  frequencyCurrent: number;
  weekFrequency: number;
  avgPositionCurrent: number;
  medianPositionCurrent: number;
  openCardCurrent: number;
  addToCartCurrent: number;
  ordersCurrent: number;
  visibilityCurrent: number;
}

export interface WbSearchReportArticle {
  nmId: number;
  items: WbSearchTextItem[];
}

export interface WbSearchReportResponse {
  currency: string;
  articles: WbSearchReportArticle[];
  cached: boolean;
  updating?: boolean;
}

export class WbSearchReportError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'WbSearchReportError';
    this.status = status;
  }
}

// ─── Хелперы дат ──────────────────────────────────────────────────────────

function shiftDate(date: string, deltaDays: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultPeriod(): { start: string; end: string } {
  const end = todayISO();
  const start = shiftDate(end, -6);
  return { start, end };
}

function periodKey(start: string, end: string): string {
  return `${start}|${end}`;
}

// ─── nmId → entity из products.json ────────────────────────────────────────

function readWbNmIdToEntityMap(): Map<number, MarketplaceEntityCode> {
  const productsPath = resolve(__dirname, '..', 'data', 'products.json');
  try {
    const raw = readFileSync(productsPath, 'utf-8');
    if (!raw.trim()) return new Map();
    const products = JSON.parse(raw) as RawProduct[];
    const map = new Map<number, MarketplaceEntityCode>();
    for (const p of products) {
      if (!p.marketplaceSkus) continue;
      for (const s of p.marketplaceSkus) {
        if (s.marketplace === 'wb' && s.kind === 'single') {
          const n = parseInt(s.article, 10);
          if (Number.isFinite(n) && n > 0) map.set(n, s.entity);
        }
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function groupNmIdsByEntity(nmIds: number[]): Map<MarketplaceEntityCode, number[]> {
  const nmIdToEntity = readWbNmIdToEntityMap();
  const groups = new Map<MarketplaceEntityCode, number[]>();
  for (const nmId of nmIds) {
    const entity = nmIdToEntity.get(nmId);
    if (!entity) continue;
    let arr = groups.get(entity);
    if (!arr) {
      arr = [];
      groups.set(entity, arr);
    }
    arr.push(nmId);
  }
  return groups;
}

function readEntityNmIdsFromJson(entity: MarketplaceEntityCode): number[] {
  const nmIdToEntity = readWbNmIdToEntityMap();
  const result: number[] = [];
  for (const [nmId, ent] of nmIdToEntity) {
    if (ent === entity) result.push(nmId);
  }
  return result.sort((a, b) => a - b);
}

// ─── Per-entity service ───────────────────────────────────────────────────

interface CacheEntry {
  article: WbSearchReportArticle;
  expiresAt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class WbSearchReportEntityService {
  private entity: MarketplaceEntityCode;
  private token: string;
  private cache: Map<number, Map<string, CacheEntry>>;
  private lastRequestAt: number;
  private warmupInProgress: boolean;
  private backgroundQueue: Array<{ nmIds: number[]; start: string; end: string; limit: number }>;
  private backgroundRunning: boolean;
  /** Периоды, для которых рефреш сейчас выполняется (чтобы показывать updating) */
  private backgroundPendingPeriods: Set<string>;

  constructor(entity: MarketplaceEntityCode, token: string) {
    this.entity = entity;
    this.token = token;
    this.cache = new Map();
    this.lastRequestAt = 0;
    this.warmupInProgress = false;
    this.backgroundQueue = [];
    this.backgroundRunning = false;
    this.backgroundPendingPeriods = new Set();

    // Загружаем кэш с диска, чтобы пережить рестарт сервера
    const nmIds = readEntityNmIdsFromJson(entity);
    const loaded = loadCache(SERVICE_NAME, entity, nmIds);
    if (loaded.size > 0) {
      this.cache = loaded as Map<number, Map<string, CacheEntry>>;
      console.log(`[wb-search-report:${entity}] loaded: ${this.cache.size} articles`);
    }
  }

  // ─── Cache helpers ──────────────────────────────────────────────────────

  private getArticleFromCache(nmId: number, key: string): WbSearchReportArticle | null {
    const byPeriod = this.cache.get(nmId);
    if (!byPeriod) return null;
    const entry = byPeriod.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) byPeriod.delete(key);
      return null;
    }
    return entry.article;
  }

  private setArticleInCache(nmId: number, key: string, article: WbSearchReportArticle): void {
    let byPeriod = this.cache.get(nmId);
    if (!byPeriod) {
      byPeriod = new Map();
      this.cache.set(nmId, byPeriod);
    }
    byPeriod.set(key, { article, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  private evictStaleNmIds(validNmIds: number[]): void {
    const validSet = new Set(validNmIds);
    for (const nmId of this.cache.keys()) {
      if (!validSet.has(nmId)) {
        this.cache.delete(nmId);
      }
    }
  }

  private replaceCacheForPeriod(key: string, articles: WbSearchReportArticle[]): void {
    for (const byPeriod of this.cache.values()) {
      byPeriod.delete(key);
    }
    for (const art of articles) {
      this.setArticleInCache(art.nmId, key, art);
    }
  }

  private persistCache(): void {
    saveCache(SERVICE_NAME, this.entity, this.cache);
  }

  /** Полностью очищает кэш в памяти и на диске. */
  private clearAllCache(): void {
    this.cache.clear();
    deleteServiceCache(SERVICE_NAME, this.entity);
  }

  // ─── Rate limiter ───────────────────────────────────────────────────────

  private async throttledFetch(body: string): Promise<Response> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < MIN_INTERVAL_MS) {
      await sleep(MIN_INTERVAL_MS - elapsed);
    }

    let res: Response;
    try {
      res = await fetch(WB_SEARCH_TEXTS_URL, {
        method: 'POST',
        headers: {
          Authorization: this.token,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (err) {
      throw new WbSearchReportError(
        `Не удалось связаться с WB API: ${err instanceof Error ? err.message : String(err)}`,
        502
      );
    }
    this.lastRequestAt = Date.now();
    return res;
  }

  private async throttledFetchWithRetry(body: string): Promise<Response> {
    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
      const res = await this.throttledFetch(body);
      if (res.status !== 429) return res;

      if (attempt === MAX_429_RETRIES) {
        throw new WbSearchReportError(
          `WB API [${this.entity}]: слишком много запросов (429), лимит исчерпан после ${MAX_429_RETRIES} попыток`,
          429
        );
      }

      const retryAfter = parseInt(res.headers.get('X-Ratelimit-Retry') ?? '65', 10);
      const waitSec = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 65, 300);
      console.log(`[wb-search-report:${this.entity}] 429, waiting ${waitSec}s before retry ${attempt + 1}/${MAX_429_RETRIES}`);
      await sleep(waitSec * 1000);
      this.lastRequestAt = 0;
    }
    throw new WbSearchReportError('WB API: неизвестная ошибка', 500);
  }

  // ─── Парсинг ────────────────────────────────────────────────────────────

  private normalizeItem(raw: WbRawSearchItem): WbSearchTextItem | null {
    const text = (raw.text ?? '').toString().trim();
    if (!text) return null;
    return {
      text,
      frequencyCurrent: raw.frequency?.current ?? 0,
      weekFrequency: raw.weekFrequency ?? 0,
      avgPositionCurrent: raw.avgPosition?.current ?? 0,
      medianPositionCurrent: raw.medianPosition?.current ?? 0,
      openCardCurrent: raw.openCard?.current ?? 0,
      addToCartCurrent: raw.addToCart?.current ?? 0,
      ordersCurrent: raw.orders?.current ?? 0,
      visibilityCurrent: raw.visibility?.current ?? 0,
    };
  }

  private groupRawByNmId(items: WbRawSearchItem[]): WbSearchReportArticle[] {
    const byNm = new Map<number, WbSearchTextItem[]>();
    for (const raw of items) {
      const nmId = raw.nmId ?? 0;
      if (!nmId) continue;
      const item = this.normalizeItem(raw);
      if (!item) continue;
      let arr = byNm.get(nmId);
      if (!arr) {
        arr = [];
        byNm.set(nmId, arr);
      }
      arr.push(item);
    }
    return [...byNm.entries()].map(([nmId, items]) => ({ nmId, items }));
  }

  // ─── Batch fetch ────────────────────────────────────────────────────────

  private async fetchBatchFromWb(
    nmIds: number[],
    start: string,
    end: string,
    limit: number
  ): Promise<WbSearchReportArticle[]> {
    const bodyObj = {
      currentPeriod: { start, end },
      nmIds,
      topOrderBy: 'openCard',
      orderBy: { field: 'openCard', mode: 'desc' },
      limit,
    };
    const body = JSON.stringify(bodyObj);

    const res = await this.throttledFetchWithRetry(body);

    if (!res.ok) {
      let detail = `WB API [${this.entity}] вернул ${res.status}`;
      try {
        const errBody = (await res.json()) as { detail?: string; title?: string };
        if (errBody.detail) detail = errBody.detail;
        else if (errBody.title) detail = errBody.title;
      } catch {
        // ignore
      }
      throw new WbSearchReportError(detail, res.status);
    }

    const raw = (await res.json()) as WbRawSearchResponse;
    const items = raw.data?.items ?? [];
    return this.groupRawByNmId(items);
  }

  // ─── Fallback: при ошибке батча → каждый nmId по отдельности ──────────

  private async fetchBatchWithFallback(
    nmIds: number[],
    start: string,
    end: string,
    limit: number
  ): Promise<WbSearchReportArticle[]> {
    try {
      return await this.fetchBatchFromWb(nmIds, start, end, limit);
    } catch {
      // Батч упал целиком — WB мог отвергнуть один из nmId (например,
      // товар слишком новый для search-texts). Пробуем по одному.
      const results: WbSearchReportArticle[] = [];
      for (const nmId of nmIds) {
        try {
          const arts = await this.fetchBatchFromWb([nmId], start, end, limit);
          results.push(...arts);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[wb-search-report:${this.entity}] skipping nmId ${nmId}: ${msg}`);
        }
      }
      return results;
    }
  }

  // ─── Warmup ─────────────────────────────────────────────────────────────

  async warmupCache(): Promise<void> {
    if (this.warmupInProgress) {
      console.log(`[wb-search-report:${this.entity}] warming: already in progress`);
      return;
    }
    this.warmupInProgress = true;

    try {
      const nmIds = readEntityNmIdsFromJson(this.entity);
      if (nmIds.length === 0) {
        console.log(`[wb-search-report:${this.entity}] warming: no articles`);
        return;
      }

      const period = defaultPeriod();
      const key = periodKey(period.start, period.end);
      console.log(`[wb-search-report:${this.entity}] warming: ${nmIds.length} articles`);

      const chunks: number[][] = [];
      for (let i = 0; i < nmIds.length; i += WARMUP_BATCH_SIZE) {
        chunks.push(nmIds.slice(i, i + WARMUP_BATCH_SIZE));
      }
      console.log(`[wb-search-report:${this.entity}] batches: ${chunks.length}`);

      const all: WbSearchReportArticle[] = [];
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) {
          console.log(`[wb-search-report:${this.entity}] batch ${i + 1}/${chunks.length} (${chunks[i].length} nmIds)`);
        }
        const articles = await this.fetchBatchWithFallback(chunks[i], period.start, period.end, WARMUP_LIMIT);
        all.push(...articles);
      }

      this.replaceCacheForPeriod(key, all);
      this.evictStaleNmIds(nmIds);
      this.persistCache();
      saveRefreshTimestamp(SERVICE_NAME, this.entity);

      const totalItems = all.reduce((sum, a) => sum + a.items.length, 0);
      const skipped = nmIds.length - all.length;
      const note = skipped > 0 ? ` (${skipped} skipped)` : '';
      console.log(`[wb-search-report:${this.entity}] ready: ${all.length}/${nmIds.length} articles, ${totalItems} queries${note}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[wb-search-report:${this.entity}] warming failed: ${msg}`);
    } finally {
      this.warmupInProgress = false;
    }
  }

  startHourlyRefresh(delayMs: number): void {
    const lastRefresh = loadRefreshTimestamp(SERVICE_NAME, this.entity);
    const now = Date.now();
    const elapsed = lastRefresh ? now - lastRefresh : Infinity;
    const sixHours = REFRESH_INTERVAL_MS;

    if (lastRefresh && elapsed < sixHours) {
      const nextIn = sixHours - elapsed;
      console.log(`[wb-search-report:${this.entity}] fresh ${Math.round(elapsed / 60000)}m ago, next refresh in ${Math.round(nextIn / 60000)}m`);
      setTimeout(() => this.warmupCache(), nextIn);
    } else {
      setTimeout(() => this.warmupCache(), delayMs);
    }

    setInterval(() => {
      this.warmupCache();
    }, sixHours);
  }

  // ─── Background refresh queue ──────────────────────────────────────────
  // Никогда не блокируем HTTP-ответ. Недостающие данные догружаются в фоне.
  // ВАЖНО: фоновый fetch НЕ ретраит 429 (чтобы очередь не блокировалась
  // на часы) и кэпнет ожидание rate limiter на 120с.

  private async backgroundFetchBatchFromWb(
    nmIds: number[],
    start: string,
    end: string,
    limit: number
  ): Promise<WbSearchReportArticle[]> {
    if (nmIds.length === 0) return [];

    const bodyObj = {
      currentPeriod: { start, end },
      nmIds,
      topOrderBy: 'openCard',
      orderBy: { field: 'openCard', mode: 'desc' },
      limit,
    };
    const body = JSON.stringify(bodyObj);

    // Rate limit с кэпом 120с — не ждём дольше
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < MIN_INTERVAL_MS) {
      await sleep(Math.min(MIN_INTERVAL_MS - elapsed, 120_000));
    }

    let res: Response;
    try {
      res = await fetch(WB_SEARCH_TEXTS_URL, {
        method: 'POST',
        headers: { Authorization: this.token, 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      throw new WbSearchReportError(
        `Не удалось связаться с WB API: ${err instanceof Error ? err.message : String(err)}`,
        502
      );
    }
    this.lastRequestAt = Date.now();

    // 429 — не ретраим, просто скипаем
    if (res.status === 429) {
      throw new WbSearchReportError(`WB API rate limited (429), background job skipped`, 429);
    }

    if (!res.ok) {
      let detail = `WB API [${this.entity}] вернул ${res.status}`;
      try {
        const errBody = (await res.json()) as { detail?: string; title?: string };
        if (errBody.detail) detail = errBody.detail;
        else if (errBody.title) detail = errBody.title;
      } catch {
        // ignore
      }
      throw new WbSearchReportError(detail, res.status);
    }

    const raw = (await res.json()) as WbRawSearchResponse;
    const items = raw.data?.items ?? [];
    return this.groupRawByNmId(items);
  }

  private scheduleBackgroundRefresh(missing: number[], start: string, end: string, limit: number): void {
    const key = periodKey(start, end);
    // Уже пробовали — не плодим попытки
    if (this.backgroundPendingPeriods.has(key)) return;
    this.backgroundPendingPeriods.add(key);
    this.backgroundQueue.push({ nmIds: missing, start, end, limit });
    this.processBackgroundQueue();
  }

  private async processBackgroundQueue(): Promise<void> {
    if (this.backgroundRunning) return;
    this.backgroundRunning = true;

    while (this.backgroundQueue.length > 0) {
      const job = this.backgroundQueue.shift()!;
      const key = periodKey(job.start, job.end);
      try {
        const all: WbSearchReportArticle[] = [];
        for (let i = 0; i < job.nmIds.length; i += WB_MAX_NMIDS_PER_REQUEST) {
          const chunk = job.nmIds.slice(i, i + WB_MAX_NMIDS_PER_REQUEST);
          const arts = await this.backgroundFetchBatchFromWb(chunk, job.start, job.end, job.limit);
          all.push(...arts);
        }
        for (const art of all) {
          this.setArticleInCache(art.nmId, key, art);
        }
        this.persistCache();
        console.log(`[wb-search-report:${this.entity}] refreshed: ${all.length}/${job.nmIds.length} articles`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[wb-search-report:${this.entity}] refreshed failed: ${msg}`);
      } finally {
        this.backgroundPendingPeriods.delete(key);
      }
    }

    this.backgroundRunning = false;
  }

  // ─── On-demand fetch (never blocks) ─────────────────────────────────────

  async fetch(
    nmIds: number[],
    startDate: string,
    endDate: string,
    limit: number
  ): Promise<{ articles: WbSearchReportArticle[]; cached: boolean; updating: boolean }> {
    if (nmIds.length === 0) {
      return { articles: [], cached: false, updating: false };
    }

    const key = periodKey(startDate, endDate);

    // 1. Собираем из кэша
    const cached: WbSearchReportArticle[] = [];
    const missing: number[] = [];
    for (const nmId of nmIds) {
      const art = this.getArticleFromCache(nmId, key);
      if (art) cached.push(art);
      else missing.push(nmId);
    }

    // 2. Всё в кэше — мгновенный ответ
    if (missing.length === 0) {
      const orderMap = new Map(nmIds.map((id, i) => [id, i]));
      const sorted = [...cached].sort(
        (a, b) => (orderMap.get(a.nmId) ?? 0) - (orderMap.get(b.nmId) ?? 0)
      );
      return { articles: sorted, cached: true, updating: false };
    }

    // 3. Недостающие есть → не блокируем, догружаем в фоне
    if (missing.length > 0 && !this.warmupInProgress) {
      this.scheduleBackgroundRefresh(missing, startDate, endDate, limit); // внутр. guard от повторов
    }

    // Сортируем то, что есть
    const allByNmId = new Map<number, WbSearchReportArticle>();
    for (const art of cached) allByNmId.set(art.nmId, art);

    const ordered: WbSearchReportArticle[] = [];
    for (const nmId of nmIds) {
      const art = allByNmId.get(nmId);
      if (art) ordered.push(art);
    }

    return { articles: ordered, cached: true, updating: this.backgroundPendingPeriods.has(key) || this.warmupInProgress };
  }
}

// ─── Raw response types ────────────────────────────────────────────────────

interface WbRawSearchItem {
  text?: string;
  nmId?: number;
  frequency?: { current?: number };
  weekFrequency?: number;
  medianPosition?: { current?: number };
  avgPosition?: { current?: number };
  openCard?: { current?: number };
  addToCart?: { current?: number };
  orders?: { current?: number };
  visibility?: { current?: number };
}

interface WbRawSearchResponse {
  data?: { items?: WbRawSearchItem[]; currency?: string };
  title?: string;
  detail?: string;
}

// ─── Service registry ─────────────────────────────────────────────────────

const services = new Map<MarketplaceEntityCode, WbSearchReportEntityService>();

function getService(entity: MarketplaceEntityCode): WbSearchReportEntityService | null {
  if (services.has(entity)) return services.get(entity)!;
  const token = getTokenForEntity(entity);
  if (!token) return null;
  const svc = new WbSearchReportEntityService(entity, token);
  services.set(entity, svc);
  return svc;
}

// ─── Public API ───────────────────────────────────────────────────────────

export function startHourlyRefresh(): void {
  const entities = getConfiguredEntities();
  if (entities.length === 0) {
    console.log('[wb-search-report] no WB tokens configured');
    return;
  }
  // Все кабинеты стартуют одновременно — у каждого свой rate limiter
  // (~1 мин/запрос для search-texts). Небольшая задержка относительно
  // sales-funnel (8 сек), чтобы логи не пересекались.
  entities.forEach((entity) => {
    const svc = getService(entity);
    if (svc) {
      svc.startHourlyRefresh(8_000);
    }
  });
}

/** Принудительный сброс кэша и перезапуск warmup для всех кабинетов. */
export function forceRefresh(): void {
  const entities = getConfiguredEntities();
  for (const entity of entities) {
    const svc = getService(entity);
    if (svc) {
      svc.clearAllCache();
      deleteRefreshTimestamp(SERVICE_NAME, entity);
      svc.warmupCache();
    }
  }
}

export async function fetchWbSearchReport(
  nmIds: number[],
  _startDate: string,
  _endDate: string,
  limit = 100
): Promise<WbSearchReportResponse> {
  // Search-texts API WB поддерживает ТОЛЬКО последние 7 дней.
  // Игнорируем переданный период и всегда используем текущую
  // катящуюся неделю — это единственное, что WB гарантирует.
  const { start: startDate, end: endDate } = defaultPeriod();

  if (nmIds.length === 0) {
    return { currency: 'RUB', articles: [], cached: false };
  }

  const groups = groupNmIdsByEntity(nmIds);
  const configuredEntities = new Set(getConfiguredEntities());
  for (const entity of groups.keys()) {
    if (!configuredEntities.has(entity)) groups.delete(entity);
  }
  if (groups.size === 0) {
    return { currency: 'RUB', articles: [], cached: false };
  }

  // Запускаем запросы по кабинетам ПАРАЛЛЕЛЬНО — у каждого кабинета свой
  // токен и свой rate limiter (~1 мин/запрос для search-texts), поэтому
  // они не мешают друг другу.
  const results = await Promise.all(
    [...groups.entries()].map(async ([entity, entityNmIds]) => {
      const svc = getService(entity);
      if (!svc) return { articles: [] as WbSearchReportArticle[], cached: true, updating: false };
      try {
        return await svc.fetch(entityNmIds, startDate, endDate, limit);
      } catch (err) {
        if (err instanceof WbSearchReportError) {
          console.error(`[wb-search-report:${entity}] fetch failed: ${err.message}`);
          return { articles: [] as WbSearchReportArticle[], cached: true, updating: false };
        }
        throw err;
      }
    })
  );

  const allArticles = results.flatMap((r) => r.articles);
  const allCached = results.every((r) => r.cached);
  const anyUpdating = results.some((r) => r.updating);

  const orderMap = new Map(nmIds.map((id, i) => [id, i]));
  allArticles.sort((a, b) => (orderMap.get(a.nmId) ?? 0) - (orderMap.get(b.nmId) ?? 0));

  return { currency: 'RUB', articles: allArticles, cached: allCached, updating: anyUpdating || undefined };
}
