// ─── WB Search Report Service ─────────────────────────────────────────────
// Прокси к WB Search Report API (search-texts / product/orders) с per-article
// кешем, фоновым warmup-ом и rate limiter-ом. WB обновляет данные раз в час,
// поэтому кеш бьём по TTL 2 часа (2× интервал обновления). Warmup при старте
// + каждый час читает products.json заново и динамически подстраивается под
// актуальное количество артикулов.
//
// В отличие от wbAnalytics (sales-funnel) этот сервис тянет **поисковые
// запросы** (text, openCard, frequency, avgPosition, visibility), по которым
// на клиенте считается оценочный органический CTR: WB API не отдаёт
// impressions напрямую, поэтому используем модель
// `impressions ≈ frequency * reach_by_position(avgPosition)`.

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { RawProduct } from '../types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WB_SEARCH_TEXTS_URL =
  'https://seller-analytics-api.wildberries.ru/api/v2/search-report/product/search-texts';
const WB_MAX_NMIDS_PER_REQUEST = 1000; // лимит WB: до 1000 nmIds за один запрос
const MIN_INTERVAL_MS = 65_000; // search-report — жёстче sales-funnel (~1 мин/запрос) + 5 сек safety
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 часа
const WARMUP_DELAY_MS = 8_000; // после wb-analytics (5 сек) — отложим, чтобы не словить 429 от WB
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 час
const MAX_429_RETRIES = 3;
const WARMUP_LIMIT = 20; // на warmup тянем top-N запросов на артикул (топ по openCard)
const WARMUP_BATCH_SIZE = 5; // артикулов за один запрос при warmup (не больше лимита nmIds)

// ─── Типы ответа WB (нормализованные) ─────────────────────────────────────

/** Одна строка поискового запроса по артикулу (после нормализации). */
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

/** Полный набор поисковых запросов для одного nmId за период. */
export interface WbSearchReportArticle {
  nmId: number;
  items: WbSearchTextItem[];
}

export interface WbSearchReportResponse {
  currency: string;
  articles: WbSearchReportArticle[];
  cached: boolean;
}

// ─── Класс ошибки ──────────────────────────────────────────────────────────

export class WbSearchReportError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'WbSearchReportError';
    this.status = status;
  }
}

// ─── Per-article кеш ───────────────────────────────────────────────────────
// articleCache: Map<nmId, Map<periodKey, { article, expiresAt }>>
// Каждый nmId кешируется отдельно для каждого периода — warmup заполняет
// дефолтный период, пользовательские запросы с другими периодами дозаполняют
// кеш по мере необходимости.

interface CacheEntry {
  article: WbSearchReportArticle;
  expiresAt: number;
}

const articleCache = new Map<number, Map<string, CacheEntry>>();

function periodKey(start: string, end: string): string {
  return `${start}|${end}`;
}

function getArticleFromCache(nmId: number, key: string): WbSearchReportArticle | null {
  const byPeriod = articleCache.get(nmId);
  if (!byPeriod) return null;
  const entry = byPeriod.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) byPeriod.delete(key);
    return null;
  }
  return entry.article;
}

function setArticleInCache(nmId: number, key: string, article: WbSearchReportArticle): void {
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
function replaceCacheForPeriod(key: string, articles: WbSearchReportArticle[]): void {
  // Удаляем старые записи этого периода у всех nmId
  for (const byPeriod of articleCache.values()) {
    byPeriod.delete(key);
  }
  // Кладём свежие
  for (const art of articles) {
    setArticleInCache(art.nmId, key, art);
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

// ─── Rate limiter: serial queue + 429 retry ───────────────────────────────

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
    res = await fetch(WB_SEARCH_TEXTS_URL, {
      method: 'POST',
      headers: {
        Authorization: process.env.WB_API_TOKEN || '',
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
      throw new WbSearchReportError(
        'WB API: слишком много запросов (429), лимит исчерпан после ' + MAX_429_RETRIES + ' попыток',
        429
      );
    }

    const retryAfter = parseInt(res.headers.get('X-Ratelimit-Retry') ?? '65', 10);
    const waitSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 65;
    console.log(`[wb-search-report] 429 received, waiting ${waitSec}s before retry ${attempt + 1}/${MAX_429_RETRIES}`);
    await sleep(waitSec * 1000);
    lastWbRequestAt = 0;
  }
  throw new WbSearchReportError('WB API: неизвестная ошибка', 500);
}

// ─── Парсинг ответа WB ────────────────────────────────────────────────────

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
  data?: {
    items?: WbRawSearchItem[];
    currency?: string;
  };
  title?: string;
  detail?: string;
}

function normalizeItem(raw: WbRawSearchItem): WbSearchTextItem | null {
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

// Группировка по nmId прямо из сырого ответа: каждая строка ответа WB
// содержит свой nmId, и несколько строк могут идти на разные запросы
// одного артикула.

function groupRawByNmId(items: WbRawSearchItem[]): WbSearchReportArticle[] {
  const byNm = new Map<number, WbSearchTextItem[]>();
  for (const raw of items) {
    const nmId = raw.nmId ?? 0;
    if (!nmId) continue;
    const item = normalizeItem(raw);
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

/** Делает один batch-запрос к WB search-texts для набора nmIds (≤ 1000) и периода. */
async function fetchBatchFromWb(
  nmIds: number[],
  start: string,
  end: string,
  limit: number
): Promise<WbSearchReportArticle[]> {
  const token = process.env.WB_API_TOKEN;
  if (!token) {
    throw new WbSearchReportError('WB_API_TOKEN не задан в .env', 500);
  }

  const bodyObj = {
    currentPeriod: { start, end },
    nmIds,
    topOrderBy: 'openCard',
    orderBy: { field: 'openCard', mode: 'desc' },
    limit,
  };
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
    throw new WbSearchReportError(detail, res.status);
  }

  const raw = (await res.json()) as WbRawSearchResponse;
  const items = raw.data?.items ?? [];
  return groupRawByNmId(items);
}

/**
 * Делает batch-запросы к WB для массива nmIds любого размера.
 * Динамически чанкует по WB_MAX_NMIDS_PER_REQUEST и ставит батчи в serial
 * queue с интервалом MIN_INTERVAL_MS. Возвращает все статьи (сгруппировано
 * по nmId).
 */
async function fetchBatched(
  nmIds: number[],
  start: string,
  end: string,
  limit: number
): Promise<WbSearchReportArticle[]> {
  if (nmIds.length === 0) return [];

  const chunks: number[][] = [];
  for (let i = 0; i < nmIds.length; i += WB_MAX_NMIDS_PER_REQUEST) {
    chunks.push(nmIds.slice(i, i + WB_MAX_NMIDS_PER_REQUEST));
  }

  const all: WbSearchReportArticle[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) {
      console.log(`  [wb-search-report] batch ${i + 1}/${chunks.length} (${chunks[i].length} nmIds)`);
    }
    const articles = await fetchBatchFromWb(chunks[i], start, end, limit);
    all.push(...articles);
  }
  return all;
}

// ─── Warmup (динамический) ───────────────────────────────────────────────

let warmupInProgress = false;

/**
 * Warmup: читает актуальные КЮА WB single-артикулы из products.json,
 * делает пакетные запросы для дефолтного периода (последние 7 дней) и
 * полностью заменяет кеш для этого периода. Эвиктит nmIds, которых больше
 * нет в products.json (динамическая чистка).
 *
 * На warmup тянем только top-20 запросов на артикул (по openCard) и
 * ограничиваем размер батча 5 артикулов, чтобы warmup не словил 429 от
 * WB: search-texts API жёстче sales-funnel, лимит ≈ 1 мин/запрос.
 */
export async function warmupKuaCache(): Promise<void> {
  if (warmupInProgress) {
    console.log('[wb-search-report] warmup skipped: already in progress');
    return;
  }
  warmupInProgress = true;

  try {
    const nmIds = readKuaWbNmIdsFromJson();
    if (nmIds.length === 0) {
      console.log('[wb-search-report] warmup: no KUA WB articles found in products.json');
      return;
    }

    const period = defaultPeriod();
    const key = periodKey(period.start, period.end);
    console.log(
      `[wb-search-report] warmup start: ${nmIds.length} articles, period ${period.start}..${period.end}, ` +
        `top ${WARMUP_LIMIT} queries per article, batch size ${WARMUP_BATCH_SIZE}`
    );

    // Чанкуем артикулы по WARMUP_BATCH_SIZE (а не по 1000) — search-texts
    // API жёстче sales-funnel, лимит ≈ 1 мин/запрос. На warmup не
    // запрашиваем все 1000 за раз, чтобы пережить пиковую нагрузку.
    const chunks: number[][] = [];
    for (let i = 0; i < nmIds.length; i += WARMUP_BATCH_SIZE) {
      chunks.push(nmIds.slice(i, i + WARMUP_BATCH_SIZE));
    }
    console.log(`[wb-search-report] batches: ${chunks.length} (max ${WARMUP_BATCH_SIZE} per batch)`);

    const all: WbSearchReportArticle[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        console.log(`  [wb-search-report] batch ${i + 1}/${chunks.length} (${chunks[i].length} nmIds)`);
      }
      const articles = await fetchBatchFromWb(chunks[i], period.start, period.end, WARMUP_LIMIT);
      all.push(...articles);
    }

    replaceCacheForPeriod(key, all);
    evictStaleNmIds(nmIds);

    const totalItems = all.reduce((sum, a) => sum + a.items.length, 0);
    console.log(
      `[wb-search-report] warmup done: ${all.length}/${nmIds.length} articles cached, ` +
        `${totalItems} search queries total, ` +
        `${nmIds.length - all.length} articles returned no search queries`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[wb-search-report] warmup failed: ${msg}`);
  } finally {
    warmupInProgress = false;
  }
}

/**
 * Запускает фоновое обновление кеша каждый час. Первый warmup — через
 * WARMUP_DELAY_MS после старта (не блокируем запуск сервера). Защита от
 * overlap: если предыдущий warmup ещё идёт, новый пропускается.
 */
export function startHourlyRefresh(): void {
  setTimeout(() => {
    warmupKuaCache();
  }, WARMUP_DELAY_MS);

  setInterval(() => {
    warmupKuaCache();
  }, REFRESH_INTERVAL_MS);

  console.log(
    `[wb-search-report] scheduled: warmup in ${WARMUP_DELAY_MS / 1000}s, refresh every ${REFRESH_INTERVAL_MS / 60000}min`
  );
}

// ─── on-demand fetch (для пользовательских запросов) ──────────────────────
// Cache-first: собираем из кеша то, что есть, для недостающих — пакетный
// запрос с throttle. Гарантирует, что дефолтный период отдаётся мгновенно
// после warmup, а кастомные периоды дозаполняют кеш по мере необходимости.

export async function fetchWbSearchReport(
  nmIds: number[],
  startDate: string,
  endDate: string,
  limit = 100
): Promise<WbSearchReportResponse> {
  if (nmIds.length === 0) {
    return { currency: 'RUB', articles: [], cached: false };
  }

  const key = periodKey(startDate, endDate);

  // 1. Собираем из кеша то, что есть
  const cached: WbSearchReportArticle[] = [];
  const missing: number[] = [];
  for (const nmId of nmIds) {
    const art = getArticleFromCache(nmId, key);
    if (art) cached.push(art);
    else missing.push(nmId);
  }

  // 2. Если всё в кеше — мгновенный ответ
  if (missing.length === 0) {
    const orderMap = new Map(nmIds.map((id, i) => [id, i]));
    const sorted = [...cached].sort(
      (a, b) => (orderMap.get(a.nmId) ?? 0) - (orderMap.get(b.nmId) ?? 0)
    );
    return { currency: 'RUB', articles: sorted, cached: true };
  }

  // 3. Для недостающих — пакетный запрос с throttle
  const fresh = await fetchBatched(missing, startDate, endDate, limit);
  for (const art of fresh) {
    setArticleInCache(art.nmId, key, art);
  }

  // 4. Объединяем cached + fresh, в порядке исходных nmIds
  const allByNmId = new Map<number, WbSearchReportArticle>();
  for (const art of cached) allByNmId.set(art.nmId, art);
  for (const art of fresh) allByNmId.set(art.nmId, art);

  const ordered: WbSearchReportArticle[] = [];
  const seen = new Set<number>();
  for (const nmId of nmIds) {
    if (seen.has(nmId)) continue;
    seen.add(nmId);
    const art = allByNmId.get(nmId);
    if (art) ordered.push(art);
  }

  return { currency: 'RUB', articles: ordered, cached: false };
}
