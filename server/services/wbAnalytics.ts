// ─── WB Analytics Service ─────────────────────────────────────────────────
// Прокси к WB Seller Analytics API с динамическим per-article кешем,
// фоновым warmup-ом и rate limiter-ом. Данные WB обновляются раз в час,
// поэтому кеш бьём по TTL 2 часа (2× интервал обновления, чтобы пережить
// сбой одного цикла). Warmup при старте + каждый час читает products.json
// заново и динамически подстраивается под актуальное количество артикулов.

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { RawProduct } from '../types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WB_API_URL = 'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products';
const WB_MAX_NMIDS_PER_REQUEST = 1000; // лимит WB: до 1000 nmIds за один запрос
const MIN_INTERVAL_MS = 21_000; // 20 сек лимит WB + 1 сек safety
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 часа (2× интервал обновления)
const WARMUP_DELAY_MS = 5_000; // первый warmup через 5 сек после старта
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 час
const MAX_429_RETRIES = 3; // максимум повторов при 429

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
    openCount: number; // уже в %, как отдаёт WB
    orderCount: number;
    orderSum: number;
    buyoutCount: number;
  };
}

export interface WbSalesFunnelResponse {
  currency: string;
  articles: WbArticleMetrics[];
  cached: boolean;
}

// ─── Класс ошибки ────────────────────────────────────────────────────────────

export class WbAnalyticsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'WbAnalyticsError';
    this.status = status;
  }
}

// ─── Per-article кеш ────────────────────────────────────────────────────────
// articleCache: Map<nmId, Map<periodKey, { article, expiresAt }>>
// Каждый nmId кешируется отдельно для каждого периода. Это позволяет
// warmup-у заполнить кеш для дефолтного периода, а пользовательские
// запросы с другими периодами дозаполнять кеш по мере необходимости.

interface CacheEntry {
  article: WbArticleMetrics;
  expiresAt: number;
}

const articleCache = new Map<number, Map<string, CacheEntry>>();

function periodKey(start: string, end: string): string {
  return `${start}|${end}`;
}

function getArticleFromCache(nmId: number, key: string): WbArticleMetrics | null {
  const byPeriod = articleCache.get(nmId);
  if (!byPeriod) return null;
  const entry = byPeriod.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) byPeriod.delete(key);
    return null;
  }
  return entry.article;
}

function setArticleInCache(nmId: number, key: string, article: WbArticleMetrics): void {
  let byPeriod = articleCache.get(nmId);
  if (!byPeriod) {
    byPeriod = new Map();
    articleCache.set(nmId, byPeriod);
  }
  byPeriod.set(key, { article, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Эвикт nmIds, которых больше нет в products.json (динамическая чистка). */
function evictStaleNmIds(validNmIds: number[]): void {
  const validSet = new Set(validNmIds);
  for (const nmId of articleCache.keys()) {
    if (!validSet.has(nmId)) {
      articleCache.delete(nmId);
    }
  }
}

/** Полностью заменить кеш для конкретного периода (используется warmup-ом). */
function replaceCacheForPeriod(key: string, articles: WbArticleMetrics[]): void {
  // Удаляем старые записи этого периода у всех nmId
  for (const byPeriod of articleCache.values()) {
    byPeriod.delete(key);
  }
  // Кладём свежие
  for (const art of articles) {
    setArticleInCache(art.nmId, key, art);
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

/** pastPeriod = той же длины, что и selected, сразу до него. */
function computePastPeriod(start: string, end: string): { start: string; end: string } {
  const len = diffDays(start, end);
  return {
    start: shiftDate(start, -(len + 1)),
    end: shiftDate(start, -1),
  };
}

/** Сегодня в формате YYYY-MM-DD (UTC). */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Дефолтный период: последние 7 дней (вчера и 6 дней до него). */
function defaultPeriod(): { start: string; end: string } {
  const end = shiftDate(todayISO(), -1);
  const start = shiftDate(end, -6);
  return { start, end };
}

// ─── Чтение КЮА WB single-артикулов из products.json ──────────────────────
// Динамическое чтение — всегда свежий список. Используем прямой readFileSync
// вместо readCollection, чтобы не зависеть от состояния jsonStore (например,
// во время dev-режима с PostgreSQL products.json может быть устаревшим, но
// для warmup это приемлемо — кеш обновится на следующем цикле).

function readKuaWbNmIdsFromJson(): number[] {
  const productsPath = resolve(__dirname, '..', 'data', 'products.json');
  try {
    const raw = readFileSync(productsPath, 'utf-8');
    if (!raw.trim()) return [];
    const products = JSON.parse(raw) as RawProduct[];
    const nmIds = new Set<number>();
    for (const p of products) {
      if (!p.marketplaceSkus) continue;
      for (const s of p.marketplaceSkus) {
        if (s.marketplace === 'wb' && s.kind === 'single' && s.entity === 'kua') {
          const n = parseInt(s.article, 10);
          if (Number.isFinite(n) && n > 0) nmIds.add(n);
        }
      }
    }
    return [...nmIds].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

// ─── Rate limiter: serial queue + 429 retry ────────────────────────────────

let lastWbRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Один запрос к WB с соблюдением минимального интервала между запросами.
 * НЕ делает retry на 429 — это задача throttledFetchWithRetry.
 */
async function throttledFetch(body: string): Promise<Response> {
  const elapsed = Date.now() - lastWbRequestAt;
  if (elapsed < MIN_INTERVAL_MS) {
    await sleep(MIN_INTERVAL_MS - elapsed);
  }

  let res: Response;
  try {
    res = await fetch(WB_API_URL, {
      method: 'POST',
      headers: {
        Authorization: process.env.WB_API_TOKEN || '',
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
  lastWbRequestAt = Date.now();
  return res;
}

/**
 * Запрос к WB с retry-логикой для 429. На 429 читает заголовок
 * X-Ratelimit-Retry, ждёт указанное количество секунд и повторяет.
 * Максимум MAX_429_RETRIES попыток.
 */
async function throttledFetchWithRetry(body: string): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const res = await throttledFetch(body);
    if (res.status !== 429) return res;

    if (attempt === MAX_429_RETRIES) {
      throw new WbAnalyticsError(
        'WB API: слишком много запросов (429), лимит исчерпан после ' + MAX_429_RETRIES + ' попыток',
        429
      );
    }

    const retryAfter = parseInt(res.headers.get('X-Ratelimit-Retry') ?? '21', 10);
    const waitSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 21;
    console.log(`[wb-analytics] 429 received, waiting ${waitSec}s before retry ${attempt + 1}/${MAX_429_RETRIES}`);
    await sleep(waitSec * 1000);
    // Сбрасываем lastWbRequestAt, чтобы не добавлять 21 сек сверху
    lastWbRequestAt = 0;
  }
  // unreachable, но TS не знает
  throw new WbAnalyticsError('WB API: неизвестная ошибка', 500);
}

// ─── Парсинг ответа WB ──────────────────────────────────────────────────────

interface WbRawProduct {
  product: {
    nmId: number;
    vendorCode: string;
  };
  statistic: {
    selected: {
      openCount: number;
      orderCount: number;
      orderSum: number;
      buyoutCount: number;
    };
    past?: {
      openCount: number;
      orderCount: number;
      orderSum: number;
      buyoutCount: number;
    };
    comparison?: {
      openCountDynamic: number;
      orderCountDynamic: number;
      orderSumDynamic: number;
      buyoutCountDynamic: number;
    };
  };
}

interface WbRawResponse {
  data?: {
    products?: WbRawProduct[];
    currency?: string;
  };
  title?: string;
  detail?: string;
}

function normalizeProduct(p: WbRawProduct): WbArticleMetrics {
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

/** Делает один batch-запрос к WB для набора nmIds (≤ 1000) и периода. */
async function fetchBatchFromWb(
  nmIds: number[],
  start: string,
  end: string
): Promise<WbArticleMetrics[]> {
  const token = process.env.WB_API_TOKEN;
  if (!token) {
    throw new WbAnalyticsError('WB_API_TOKEN не задан в .env', 500);
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

  const res = await throttledFetchWithRetry(body);

  if (!res.ok) {
    let detail = `WB API вернул ${res.status}`;
    try {
      const errBody = (await res.json()) as { detail?: string; title?: string };
      if (errBody.detail) detail = errBody.detail;
      else if (errBody.title) detail = errBody.title;
    } catch {
      // ignore parse error
    }
    throw new WbAnalyticsError(detail, res.status);
  }

  const raw = (await res.json()) as WbRawResponse;
  const products = raw.data?.products ?? [];
  return products.map(normalizeProduct);
}

/**
 * Делает batch-запросы к WB для массива nmIds любого размера.
 * Динамически чанкует по WB_MAX_NMIDS_PER_REQUEST и ставит батчи в serial
 * queue с интервалом MIN_INTERVAL_MS. Возвращает все статьи.
 */
async function fetchBatched(
  nmIds: number[],
  start: string,
  end: string
): Promise<WbArticleMetrics[]> {
  if (nmIds.length === 0) return [];

  // Чанкуем по 1000
  const chunks: number[][] = [];
  for (let i = 0; i < nmIds.length; i += WB_MAX_NMIDS_PER_REQUEST) {
    chunks.push(nmIds.slice(i, i + WB_MAX_NMIDS_PER_REQUEST));
  }

  const all: WbArticleMetrics[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) {
      // Между батчами — интервал. throttledFetch внутри уже следит за
      // интервалом, но явный лог полезен для диагностики.
      console.log(`  [wb-analytics] batch ${i + 1}/${chunks.length} (${chunks[i].length} nmIds)`);
    }
    const articles = await fetchBatchFromWb(chunks[i], start, end);
    all.push(...articles);
  }
  return all;
}

// ─── Warmup (динамический) ──────────────────────────────────────────────────

let warmupInProgress = false;

/**
 * Warmup: читает актуальные КЮА WB single-артикулы из products.json,
 * делает пакетный запрос для дефолтного периода (последние 7 дней) и
 * полностью заменяет кеш для этого периода. Эвиктит nmIds, которых
 * больше нет в products.json (динамическая чистка).
 */
export async function warmupKuaCache(): Promise<void> {
  if (warmupInProgress) {
    console.log('[wb-analytics] warmup skipped: already in progress');
    return;
  }
  warmupInProgress = true;

  try {
    const nmIds = readKuaWbNmIdsFromJson();
    if (nmIds.length === 0) {
      console.log('[wb-analytics] warmup: no KUA WB articles found in products.json');
      return;
    }

    const period = defaultPeriod();
    const key = periodKey(period.start, period.end);
    console.log(
      `[wb-analytics] warmup start: ${nmIds.length} articles, period ${period.start}..${period.end}`
    );

    const batchCount = Math.ceil(nmIds.length / WB_MAX_NMIDS_PER_REQUEST);
    console.log(`[wb-analytics] batches: ${batchCount} (max ${WB_MAX_NMIDS_PER_REQUEST} per batch)`);

    const articles = await fetchBatched(nmIds, period.start, period.end);

    // Полностью заменяем кеш для дефолтного периода
    replaceCacheForPeriod(key, articles);

    // Эвикт nmIds, которых больше нет в products.json
    evictStaleNmIds(nmIds);

    console.log(
      `[wb-analytics] warmup done: ${articles.length}/${nmIds.length} articles cached, ` +
        `${nmIds.length - articles.length} not returned by WB (maybe not listed yet)`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[wb-analytics] warmup failed: ${msg}`);
  } finally {
    warmupInProgress = false;
  }
}

/**
 * Запускает фоновое обновление кеша каждый час. Первый warmup — через
 * WARMUP_DELAY_MS после старта (не блокируем запуск сервера). Защита
 * от overlap: если предыдущий warmup ещё идёт, новый пропускается.
 */
export function startHourlyRefresh(): void {
  setTimeout(() => {
    warmupKuaCache();
  }, WARMUP_DELAY_MS);

  setInterval(() => {
    warmupKuaCache();
  }, REFRESH_INTERVAL_MS);

  console.log(
    `[wb-analytics] scheduled: warmup in ${WARMUP_DELAY_MS / 1000}s, refresh every ${REFRESH_INTERVAL_MS / 60000}min`
  );
}

// ─── on-demand fetch (для пользовательских запросов) ──────────────────────
// Cache-first: собираем из кеша то, что есть, для недостающих — пакетный
// запрос с throttle. Гарантирует, что дефолтный период отдаётся мгновенно
// после warmup, а кастомные периоды дозаполняют кеш по мере необходимости.

export async function fetchWbSalesFunnel(
  nmIds: number[],
  startDate: string,
  endDate: string
): Promise<WbSalesFunnelResponse> {
  if (nmIds.length === 0) {
    return { currency: 'RUB', articles: [], cached: false };
  }

  const key = periodKey(startDate, endDate);

  // 1. Собираем из кеша то, что есть
  const cached: WbArticleMetrics[] = [];
  const missing: number[] = [];
  for (const nmId of nmIds) {
    const art = getArticleFromCache(nmId, key);
    if (art) cached.push(art);
    else missing.push(nmId);
  }

  // 2. Если всё в кеше — мгновенный ответ
  if (missing.length === 0) {
    // Сортируем в порядке исходных nmIds (убираем дубликаты, сохраняя порядок)
    const orderMap = new Map(nmIds.map((id, i) => [id, i]));
    const sorted = [...cached].sort((a, b) => (orderMap.get(a.nmId) ?? 0) - (orderMap.get(b.nmId) ?? 0));
    return { currency: 'RUB', articles: sorted, cached: true };
  }

  // 3. Для недостающих — пакетный запрос с throttle
  const fresh = await fetchBatched(missing, startDate, endDate);
  for (const art of fresh) {
    setArticleInCache(art.nmId, key, art);
  }

  // 4. Объединяем cached + fresh, в порядке исходных nmIds
  const allByNmId = new Map<number, WbArticleMetrics>();
  for (const art of cached) allByNmId.set(art.nmId, art);
  for (const art of fresh) allByNmId.set(art.nmId, art);

  const ordered: WbArticleMetrics[] = [];
  const seen = new Set<number>();
  for (const nmId of nmIds) {
    if (seen.has(nmId)) continue;
    seen.add(nmId);
    const art = allByNmId.get(nmId);
    if (art) ordered.push(art);
  }

  return { currency: 'RUB', articles: ordered, cached: false };
}
