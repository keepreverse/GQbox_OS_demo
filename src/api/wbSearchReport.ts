// ─── WB Search Report frontend client ────────────────────────────────────
// Тонкий клиент поверх /api/analytics/wb/search-report. Бэкенд тянет
// search-texts API WB, кеширует per-nmId на 2 часа, throttle ~1 мин/запрос.
//
// CTR на клиенте считается оценочно: WB API не отдаёт impressions напрямую,
// поэтому используем модель
// `impressions ≈ frequency * reach_by_position(avgPosition)`.

import { request } from './client';

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
}

/**
 * Параметры reach_by_position по умолчанию (логистическая модель видимости).
 * Используется как fallback, если visibility=0. mu=18, s=7 — стартовая
 * калибровка; на больших выборках можно откалибровать по реальным данным
 * из ЛК WB.
 */
const REACH_MU = 18;
const REACH_S = 7;

export function reachByPosition(position: number, mu = REACH_MU, s = REACH_S): number {
  if (!Number.isFinite(position) || position <= 0) return 1;
  return 1 / (1 + Math.exp((position - mu) / s));
}

/**
 * Основная модель reach (доля пользователей, увидевших товар):
 * 1) `visibility / 100` — WB-индекс видимости, percentile 0-100. Ближе всего
 *    к реальной доле показов, особенно на глубоких позициях (sigmoid по
 *    позиции слишком агрессивен: на позиции 50 reach≈1%, а реальный WB
 *    visibility может быть 20-50%).
 * 2) Fallback на `reachByPosition` если visibility=0.
 * 3) Fallback на 1 если нет ни visibility, ни позиции.
 */
function getReach(item: WbSearchTextItem): number {
  if (item.visibilityCurrent > 0) {
    return item.visibilityCurrent / 100;
  }
  if (item.avgPositionCurrent > 0) {
    return reachByPosition(item.avgPositionCurrent);
  }
  return 1;
}

export interface EstimatedQueryCtr {
  organicClicks: number;
  estimatedImpressions: number;
  estimatedCtr: number; // в процентах
  reach: number;
}

/** Оценочный органический CTR для одного поискового запроса. */
export function estimateQueryCtr(
  item: WbSearchTextItem,
  paidClicks = 0
): EstimatedQueryCtr {
  const organicClicks = Math.max(0, item.openCardCurrent - paidClicks);
  const reach = getReach(item);
  let impressions = item.frequencyCurrent * reach;
  if (item.frequencyCurrent === 0) {
    impressions = item.openCardCurrent;
  }
  // Защита: impressions не меньше кликов, иначе CTR > 100%
  impressions = Math.max(impressions, organicClicks);
  const ctr = impressions > 0 ? (organicClicks / impressions) * 100 : 0;
  return {
    organicClicks,
    estimatedImpressions: Math.round(impressions),
    estimatedCtr: Math.min(100, ctr),
    reach,
  };
}

/** Агрегатор по всем запросам артикула. Возвращает только расчётные поля. */
export function estimateSearchTotals(items: WbSearchTextItem[]): {
  totalSearchOpenCard: number; // сумма openCard только по top-100 запросам
  totalImpressions: number; // оценка суммарных показов
} {
  let openCard = 0;
  let impressions = 0;
  for (const it of items) {
    const e = estimateQueryCtr(it);
    openCard += e.organicClicks;
    impressions += e.estimatedImpressions;
  }
  return { totalSearchOpenCard: openCard, totalImpressions: impressions };
}

export interface SearchReportAggregate {
  totalImpressions: number; // расчётные показы (search-texts × reach)
  totalOpenCount: number; // авторитетный openCount из sales-funnel
  totalCtr: number; // openCount / impressions
  coverage: number; // search-texts sum openCard / sales-funnel openCount
}

/**
 * Агрегатор по всем запросам одного артикула. Принимает авторитетный
 * `salesFunnelOpenCount` (из sales-funnel API), который ВСЕГДА больше или
 * равен сумме openCard по top-100 запросам (search-texts возвращает только
 * топ, а sales-funnel — все). Используется для расчёта CTR.
 *
 * `coverage` показывает, какую долю переходов в карточку покрывают top-100
 * поисковых запросов. Низкое покрытие (<50%) означает, что много переходов
 * идёт из непокрытых запросов, и оценка impressions/CTR — только по видимой
 * части семантики.
 */
export function aggregateSearchReport(
  items: WbSearchTextItem[],
  salesFunnelOpenCount: number
): SearchReportAggregate {
  const { totalSearchOpenCard, totalImpressions } = estimateSearchTotals(items);
  const totalOpenCount = Math.max(0, salesFunnelOpenCount);
  const totalCtr =
    totalOpenCount > 0 && totalImpressions > 0
      ? Math.min(100, (totalOpenCount / totalImpressions) * 100)
      : 0;
  const coverage =
    totalOpenCount > 0
      ? Math.min(100, (totalSearchOpenCard / totalOpenCount) * 100)
      : 0;
  return {
    totalImpressions,
    totalOpenCount,
    totalCtr,
    coverage,
  };
}

export async function fetchWbSearchReport(
  nmIds: number[],
  startDate: string,
  endDate: string,
  limit = 100
): Promise<WbSearchReportResponse> {
  return request<WbSearchReportResponse>('/api/analytics/wb/search-report', {
    method: 'POST',
    body: JSON.stringify({ nmIds, startDate, endDate, limit }),
  });
}
