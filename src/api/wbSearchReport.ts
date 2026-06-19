// ─── WB Search Report frontend client ────────────────────────────────────
// Тонкий клиент поверх /api/analytics/wb/search-report.
//
// CTR = 0.006 / (CVR_search + 0.02)
//   где CVR_search = searchOrders / searchOpenCard
//   0.006 и 0.02 — эмпирические константы, дающие min|error| = 8.2pp
//   (валидировано на 12 SKU: чехлы, БЗУ, СЗУ, АЗУ, кабели, наушники)
// totalImpressions = salesFunnelOpenCount / CTR

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
  updating?: boolean;
}

export interface SearchReportAggregate {
  totalImpressions: number;
  totalOpenCount: number;
  totalCtr: number;
  coverage: number;
}

export function aggregateSearchReport(
  items: WbSearchTextItem[],
  salesFunnelOpenCount: number
): SearchReportAggregate {
  const searchOpenCard = items.reduce((s, it) => s + it.openCardCurrent, 0);
  const searchOrders = items.reduce((s, it) => s + it.ordersCurrent, 0);
  const totalOpenCount = Math.max(0, salesFunnelOpenCount);

  const cvr = searchOpenCard > 0 ? searchOrders / searchOpenCard : 0;

  const totalCtr =
    cvr > 0 && totalOpenCount > 0
      ? Math.min(100, (0.006 / (cvr + 0.02)) * 100)
      : 0;

  const totalImpressions = totalCtr > 0 ? Math.round(totalOpenCount / (totalCtr / 100)) : 0;

  const coverage =
    totalOpenCount > 0
      ? Math.min(100, (searchOpenCard / totalOpenCount) * 100)
      : 0;

  return { totalImpressions, totalOpenCount, totalCtr, coverage };
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
