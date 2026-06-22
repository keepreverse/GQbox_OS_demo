// ─── WB Analytics Service (multi-entity) ──────────────────────────────────
// Прокси к WB Seller Analytics API с динамическим per-article кэшем,
// фоновым warmup-ом и rate limiter-ом. Данные WB обновляются раз в час,
// поэтому кэш бьём по TTL 2 часа (2× интервал обновления, чтобы пережить
// сбой одного цикла). Warmup при старте + каждый час читает products.json
// заново и динамически подстраивается под актуальное количество артикулов.
//
// **Multi-entity**: каждый кабинет (КЮА, КАА, ДЕВ, БМС) имеет свой токен,
// свой кэш, свой rate limiter и свой warmup-расписанием. nmId→entity
// резолвится из products.json, после чего запрос маршрутизируется в
// сервис соответствующего кабинета. Это позволяет:
//   - параллельно тянуть данные из разных кабинетов (у каждого свой лимит);
//   - не словить 400 "Check correctness of nm id" от чужого кабинета;
//   - добавлять новые кабинеты просто добавив токен в .env.

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { RawProduct, MarketplaceEntityCode } from '../types';
import { saveCache, loadCache, saveRefreshTimestamp, loadRefreshTimestamp, deleteRefreshTimestamp, deleteServiceCache } from './cacheStore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WB_API_URL = 'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products';
const WB_MAX_NMIDS_PER_REQUEST = 1000;
const MIN_INTERVAL_MS = 21_000;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_429_RETRIES = 3;
const SERVICE_NAME = 'wb-analytics';

// ─── Entity / token resolution ────────────────────────────────────────────

const ENTITY_ORDER: MarketplaceEntityCode[] = ['kua', 'kaa', 'dev'];

/**
 * Возвращает токен для данного кабинета.
 * Приоритет: `WB_API_TOKEN_<ENTITY>` → `WB_API_TOKEN_KUA` (только для КЮА).
 */
function getTokenForEntity(entity: MarketplaceEntityCode): string {
  const explicit = process.env[`WB_API_TOKEN_${entity.toUpperCase()}`];
  if (explicit) return explicit;
  if (entity === 'kua') return process.env.WB_API_TOKEN_KUA || '';
  return '';
}

/** Список кабинетов, для которых задан токен. */
function getConfiguredEntities(): MarketplaceEntityCode[] {
  return ENTITY_ORDER.filter((e) => getTokenForEntity(e) !== '');
}

// ─── Типы ответа WB (нормализованные) ──────────────────────────────────────

export interface WbArticleMetrics {
  nmId: number;
  vendorCode: string;
  selected: {
    openCount: number;
    orderCount: number;
    orderSum: number;
    buyoutCount: number;
  };
  past: {
    openCount: number;
    orderCount: number;
    orderSum: number;
    buyoutCount: number;
  };
  dynamics: {
    openCount: number;
    orderCount: number;
    orderSum: number;
    buyoutCount: number;
  };
}

export interface WbSalesFunnelResponse {
  currency: string;
  articles: WbArticleMetrics[];
  cached: boolean;
  updating?: boolean;
}

export class WbAnalyticsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'WbAnalyticsError';
    this.status = status;
  }
}

// ─── Хелперы дат ────────────────────────────────────────────────────────────

function diffDays(start: string, end: string): number {
  const s = new Date(start + 'T00:00:00Z').getTime();
  const e = new Date(end + 'T00:00:00Z').getTime();
  return Math.round((e - s) / 86400000);
}

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
// Динамическое чтение — всегда свежий список.

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

/** Группирует nmIds по entity, используя products.json. */
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

/** Читает все nmIds данного кабинета из products.json. */
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
  article: WbArticleMetrics;
  expiresAt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Сервис аналитики одного кабинета WB. Каждый экземпляр имеет:
 *   - свой токен (доступ только к nmIds этого кабинета);
 *   - свой per-nmId кэш (Map<nmId, Map<periodKey, entry>>);
 *   - свой rate limiter (serial queue с интервалом MIN_INTERVAL_MS);
 *   - свой warmup guard.
 *
 * Это даёт параллельность: КЮА/КАА/ДЕВ тянутся одновременно, каждый в
 * рамках своего лимита ~20 сек/запрос.
 */
class WbEntityAnalyticsService {
  private entity: MarketplaceEntityCode;
  private token: string;
  private cache: Map<number, Map<string, CacheEntry>>;
  private lastRequestAt: number;
  private warmupInProgress: boolean;
  private backgroundQueue: Array<{ nmIds: number[]; start: string; end: string }>;
  private backgroundRunning: boolean;
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
      console.log(`[wb-analytics:${entity}] loaded: ${this.cache.size} articles`);
    }
  }

  // ─── Cache helpers ──────────────────────────────────────────────────────

  private getArticleFromCache(nmId: number, key: string): WbArticleMetrics | null {
    const byPeriod = this.cache.get(nmId);
    if (!byPeriod) return null;
    const entry = byPeriod.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) byPeriod.delete(key);
      return null;
    }
    return entry.article;
  }

  private setArticleInCache(nmId: number, key: string, article: WbArticleMetrics): void {
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

  private replaceCacheForPeriod(key: string, articles: WbArticleMetrics[]): void {
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
      res = await fetch(WB_API_URL, {
        method: 'POST',
        headers: {
          Authorization: this.token,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (err) {
      throw new WbAnalyticsError(
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
        throw new WbAnalyticsError(
          `WB API [${this.entity}]: слишком много запросов (429), лимит исчерпан после ${MAX_429_RETRIES} попыток`,
          429
        );
      }

      const retryAfter = parseInt(res.headers.get('X-Ratelimit-Retry') ?? '21', 10);
      const waitSec = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 21, 300);
      console.log(`[wb-analytics:${this.entity}] 429, waiting ${waitSec}s before retry ${attempt + 1}/${MAX_429_RETRIES}`);
      await sleep(waitSec * 1000);
      this.lastRequestAt = 0;
    }
    throw new WbAnalyticsError('WB API: неизвестная ошибка', 500);
  }

  // ─── Парсинг ────────────────────────────────────────────────────────────

  private normalizeProduct(p: WbRawProduct): WbArticleMetrics {
    return {
      nmId: p.product.nmId,
      vendorCode: p.product.vendorCode,
      selected: {
        openCount: p.statistic.selected.openCount,
        orderCount: p.statistic.selected.orderCount,
        orderSum: p.statistic.selected.orderSum,
        buyoutCount: p.statistic.selected.buyoutCount,
      },
      past: p.statistic.past
        ? {
            openCount: p.statistic.past.openCount,
            orderCount: p.statistic.past.orderCount,
            orderSum: p.statistic.past.orderSum,
            buyoutCount: p.statistic.past.buyoutCount,
          }
        : { openCount: 0, orderCount: 0, orderSum: 0, buyoutCount: 0 },
      dynamics: p.statistic.comparison
        ? {
            openCount: p.statistic.comparison.openCountDynamic,
            orderCount: p.statistic.comparison.orderCountDynamic,
            orderSum: p.statistic.comparison.orderSumDynamic,
            buyoutCount: p.statistic.comparison.buyoutCountDynamic,
          }
        : { openCount: 0, orderCount: 0, orderSum: 0, buyoutCount: 0 },
    };
  }

  // ─── Batch fetch ────────────────────────────────────────────────────────

  private async fetchBatchFromWb(
    nmIds: number[],
    start: string,
    end: string
  ): Promise<WbArticleMetrics[]> {
    const minStart = shiftDate(todayISO(), -364);
    if (start < minStart) {
      throw new WbAnalyticsError(
        `selectedPeriod.start (${start}) выходит за пределы 365-дневного окна WB API. Минимальная startDate: ${minStart}`,
        400
      );
    }

    const past = computePastPeriod(start, end);
    const pastWithinLimit = past.start >= shiftDate(todayISO(), -365);

    const bodyObj: Record<string, unknown> = {
      selectedPeriod: { start, end },
      nmIds,
    };
    if (pastWithinLimit) {
      bodyObj.pastPeriod = { start: past.start, end: past.end };
    }
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
      throw new WbAnalyticsError(detail, res.status);
    }

    const raw = (await res.json()) as WbRawResponse;
    const products = raw.data?.products ?? [];
    return products.map((p) => {
      const normalized = this.normalizeProduct(p);
      if (!pastWithinLimit) {
        normalized.past = { openCount: 0, orderCount: 0, orderSum: 0, buyoutCount: 0 };
        normalized.dynamics = { openCount: 0, orderCount: 0, orderSum: 0, buyoutCount: 0 };
      }
      return normalized;
    });
  }

  private async fetchBatched(
    nmIds: number[],
    start: string,
    end: string
  ): Promise<WbArticleMetrics[]> {
    if (nmIds.length === 0) return [];

    const chunks: number[][] = [];
    for (let i = 0; i < nmIds.length; i += WB_MAX_NMIDS_PER_REQUEST) {
      chunks.push(nmIds.slice(i, i + WB_MAX_NMIDS_PER_REQUEST));
    }

    const all: WbArticleMetrics[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        console.log(`[wb-analytics:${this.entity}] batch ${i + 1}/${chunks.length} (${chunks[i].length} nmIds)`);
      }
      const articles = await this.fetchBatchFromWb(chunks[i], start, end);
      all.push(...articles);
    }
    return all;
  }

  // ─── Warmup ─────────────────────────────────────────────────────────────

  async warmupCache(): Promise<void> {
    if (this.warmupInProgress) {
      console.log(`[wb-analytics:${this.entity}] warming: already in progress`);
      return;
    }
    this.warmupInProgress = true;

    try {
      const nmIds = readEntityNmIdsFromJson(this.entity);
      if (nmIds.length === 0) {
        console.log(`[wb-analytics:${this.entity}] warming: no articles`);
        return;
      }

      const period = defaultPeriod();
      const key = periodKey(period.start, period.end);
      console.log(`[wb-analytics:${this.entity}] warming: ${nmIds.length} articles`);

      const batchCount = Math.ceil(nmIds.length / WB_MAX_NMIDS_PER_REQUEST);
      console.log(`[wb-analytics:${this.entity}] batches: ${batchCount}`);

      const articles = await this.fetchBatched(nmIds, period.start, period.end);

      this.replaceCacheForPeriod(key, articles);
      this.evictStaleNmIds(nmIds);
      this.persistCache();
      saveRefreshTimestamp(SERVICE_NAME, this.entity);

      const note = nmIds.length - articles.length > 0 ? ` (${nmIds.length - articles.length} missing)` : '';
      console.log(`[wb-analytics:${this.entity}] ready: ${articles.length}/${nmIds.length} articles${note}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[wb-analytics:${this.entity}] warming failed: ${msg}`);
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
      console.log(`[wb-analytics:${this.entity}] fresh ${Math.round(elapsed / 60000)}m ago, next refresh in ${Math.round(nextIn / 60000)}m`);
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
  // ВАЖНО: фоновый fetch НЕ ретраит 429 и кэпнет ожидание на 120с.

  private async backgroundFetchBatchFromWb(
    nmIds: number[],
    start: string,
    end: string
  ): Promise<WbArticleMetrics[]> {
    if (nmIds.length === 0) return [];

    const minStart = shiftDate(todayISO(), -364);
    if (start < minStart) {
      throw new WbAnalyticsError(
        `selectedPeriod.start (${start}) выходит за пределы 365-дневного окна WB API. Минимальная startDate: ${minStart}`,
        400
      );
    }

    const past = computePastPeriod(start, end);
    const pastWithinLimit = past.start >= shiftDate(todayISO(), -365);
    const bodyObj: Record<string, unknown> = { selectedPeriod: { start, end }, nmIds };
    if (pastWithinLimit) bodyObj.pastPeriod = { start: past.start, end: past.end };
    const body = JSON.stringify(bodyObj);

    // Rate limit с кэпом 120с
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < MIN_INTERVAL_MS) {
      await sleep(Math.min(MIN_INTERVAL_MS - elapsed, 120_000));
    }

    let res: Response;
    try {
      res = await fetch(WB_API_URL, {
        method: 'POST',
        headers: { Authorization: this.token, 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      throw new WbAnalyticsError(
        `Не удалось связаться с WB API: ${err instanceof Error ? err.message : String(err)}`,
        502
      );
    }
    this.lastRequestAt = Date.now();

    if (res.status === 429) {
      throw new WbAnalyticsError(`WB API rate limited (429), background job skipped`, 429);
    }

    if (!res.ok) {
      let detail = `WB API [${this.entity}] вернул ${res.status}`;
      try {
        const errBody = (await res.json()) as { detail?: string; title?: string };
        if (errBody.detail) detail = errBody.detail;
        else if (errBody.title) detail = errBody.title;
      } catch { /* ignore */ }
      throw new WbAnalyticsError(detail, res.status);
    }

    const raw = (await res.json()) as WbRawResponse;
    const products = raw.data?.products ?? [];
    return products.map((p) => {
      const normalized = this.normalizeProduct(p);
      if (!pastWithinLimit) {
        normalized.past = { openCount: 0, orderCount: 0, orderSum: 0, buyoutCount: 0 };
        normalized.dynamics = { openCount: 0, orderCount: 0, orderSum: 0, buyoutCount: 0 };
      }
      return normalized;
    });
  }

  private scheduleBackgroundRefresh(missing: number[], start: string, end: string): void {
    const key = periodKey(start, end);
    if (this.backgroundPendingPeriods.has(key)) return;
    this.backgroundPendingPeriods.add(key);
    this.backgroundQueue.push({ nmIds: missing, start, end });
    this.processBackgroundQueue();
  }

  private async processBackgroundQueue(): Promise<void> {
    if (this.backgroundRunning) return;
    this.backgroundRunning = true;

    while (this.backgroundQueue.length > 0) {
      const job = this.backgroundQueue.shift()!;
      const key = periodKey(job.start, job.end);
      try {
        const all: WbArticleMetrics[] = [];
        for (let i = 0; i < job.nmIds.length; i += WB_MAX_NMIDS_PER_REQUEST) {
          const chunk = job.nmIds.slice(i, i + WB_MAX_NMIDS_PER_REQUEST);
          const arts = await this.backgroundFetchBatchFromWb(chunk, job.start, job.end);
          all.push(...arts);
        }
        for (const art of all) {
          this.setArticleInCache(art.nmId, key, art);
        }
        this.persistCache();
        console.log(`[wb-analytics:${this.entity}] refreshed: ${all.length}/${job.nmIds.length} articles`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[wb-analytics:${this.entity}] refreshed failed: ${msg}`);
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
    endDate: string
  ): Promise<{ articles: WbArticleMetrics[]; cached: boolean; updating: boolean }> {
    if (nmIds.length === 0) {
      return { articles: [], cached: false, updating: false };
    }

    const key = periodKey(startDate, endDate);

    // 1. Собираем из кэша
    const cached: WbArticleMetrics[] = [];
    const missing: number[] = [];
    for (const nmId of nmIds) {
      const art = this.getArticleFromCache(nmId, key);
      if (art) cached.push(art);
      else missing.push(nmId);
    }

    // 2. Всё в кэше — мгновенный ответ
    if (missing.length === 0) {
      const orderMap = new Map(nmIds.map((id, i) => [id, i]));
      const sorted = [...cached].sort((a, b) => (orderMap.get(a.nmId) ?? 0) - (orderMap.get(b.nmId) ?? 0));
      return { articles: sorted, cached: true, updating: false };
    }

    // 3. Недостающие есть → не блокируем, догружаем в фоне
    if (missing.length > 0 && !this.warmupInProgress) {
      this.scheduleBackgroundRefresh(missing, startDate, endDate); // внутр. guard от повторов
    }

    // Сортируем то, что есть
    const allByNmId = new Map<number, WbArticleMetrics>();
    for (const art of cached) allByNmId.set(art.nmId, art);

    const ordered: WbArticleMetrics[] = [];
    for (const nmId of nmIds) {
      const art = allByNmId.get(nmId);
      if (art) ordered.push(art);
    }

    return { articles: ordered, cached: true, updating: this.backgroundPendingPeriods.has(key) || this.warmupInProgress };
  }
}

// ─── Raw response types ────────────────────────────────────────────────────

interface WbRawProduct {
  product: { nmId: number; vendorCode: string };
  statistic: {
    selected: { openCount: number; orderCount: number; orderSum: number; buyoutCount: number };
    past?: { openCount: number; orderCount: number; orderSum: number; buyoutCount: number };
    comparison?: {
      openCountDynamic: number;
      orderCountDynamic: number;
      orderSumDynamic: number;
      buyoutCountDynamic: number;
    };
  };
}

interface WbRawResponse {
  data?: { products?: WbRawProduct[]; currency?: string };
  title?: string;
  detail?: string;
}

function computePastPeriod(start: string, end: string): { start: string; end: string } {
  const len = diffDays(start, end);
  return {
    start: shiftDate(start, -(len + 1)),
    end: shiftDate(start, -1),
  };
}

// ─── Service registry ─────────────────────────────────────────────────────
// Ленивая инициализация: сервис создаётся при первом обращении.

const services = new Map<MarketplaceEntityCode, WbEntityAnalyticsService>();

function getService(entity: MarketplaceEntityCode): WbEntityAnalyticsService | null {
  if (services.has(entity)) return services.get(entity)!;
  const token = getTokenForEntity(entity);
  if (!token) return null;
  const svc = new WbEntityAnalyticsService(entity, token);
  services.set(entity, svc);
  return svc;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Запускает фоновое обновление кэша для всех кабинетов, у которых задан
 * токен. Каждый кабинет имеет свой независимый rate limiter, поэтому
 * warmup-ы запускаются одновременно — они не мешают друг другу.
 */
export function startHourlyRefresh(): void {
  const entities = getConfiguredEntities();
  if (entities.length === 0) {
    console.log('[wb-analytics] no WB tokens configured');
    return;
  }
  entities.forEach((entity) => {
    const svc = getService(entity);
    if (svc) {
      // Все кабинеты стартуют одновременно — у каждого свой rate limiter
      svc.startHourlyRefresh(5_000);
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

/**
 * Мульти-кабинетный fetch: группирует nmIds по entity (из products.json),
 * маршрутизирует каждый пул в сервис соответствующего кабинета.
 * Артикулы без сконфигурированного токена пропускаются молча.
 */
export async function fetchWbSalesFunnel(
  nmIds: number[],
  startDate: string,
  endDate: string
): Promise<WbSalesFunnelResponse> {
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
  // токен и свой rate limiter (~20 сек/запрос), поэтому они не мешают друг
  // другу. 3 кабинета × 1 батч = ~20 сек суммарно (а не ~60 сек последовательно).
  const results = await Promise.all(
    [...groups.entries()].map(async ([entity, entityNmIds]) => {
      const svc = getService(entity);
      if (!svc) return { articles: [] as WbArticleMetrics[], cached: true, updating: false };
      try {
        return await svc.fetch(entityNmIds, startDate, endDate);
      } catch (err) {
        if (err instanceof WbAnalyticsError) {
          console.error(`[wb-analytics:${entity}] fetch failed: ${err.message}`);
          return { articles: [] as WbArticleMetrics[], cached: true, updating: false };
        }
        throw err;
      }
    })
  );

  const allArticles = results.flatMap((r) => r.articles);
  const allCached = results.every((r) => r.cached);
  const anyUpdating = results.some((r) => r.updating);

  // Сортируем в порядке исходных nmIds
  const orderMap = new Map(nmIds.map((id, i) => [id, i]));
  allArticles.sort((a, b) => (orderMap.get(a.nmId) ?? 0) - (orderMap.get(b.nmId) ?? 0));

  return { currency: 'RUB', articles: allArticles, cached: allCached, updating: anyUpdating || undefined };
}
