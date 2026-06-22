import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { MarketplaceEntityCode } from '../types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TOKEN_URL = 'https://api-performance.ozon.ru/api/client/token';
const CAMPAIGN_URL = 'https://api-performance.ozon.ru/api/client/campaign?advObjectType=SKU';
const STATS_URL = 'https://api-performance.ozon.ru/api/client/statistics/products/sku';

const CACHE_DIR = resolve(__dirname, '..', 'data', 'cache');
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

interface PerfCredentials {
  clientId: string;
  clientSecret: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface CampaignListResponse {
  list: Array<{ id: number; title?: string; state?: string }>;
}

interface ClickStatsRow {
  sku: number;
  clicks: number;
  views: number;
  date?: string;
}

interface ClickStatsResponse {
  result?: ClickStatsRow[];
}

interface PerfStats {
  clicks: number;
  views: number;
}

function getPerfCredentials(entity: MarketplaceEntityCode): PerfCredentials | null {
  const clientId = process.env[`OZON_PERF_CLIENT_ID_${entity.toUpperCase()}`] || '';
  const clientSecret = process.env[`OZON_PERF_CLIENT_SECRET_${entity.toUpperCase()}`] || '';
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function cacheFilePath(service: string, entity: MarketplaceEntityCode): string {
  return resolve(CACHE_DIR, `${service}-${entity}.json`);
}

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

class OzonPerformanceService {
  private entity: MarketplaceEntityCode;
  private credentials: PerfCredentials;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private campaigns: number[] | null = null;
  private campaignsExpiresAt: number = 0;
  /** periodKey → Map<sku, PerfStats> */
  private statsCache: Map<string, Map<number, PerfStats>> = new Map();
  private lastRequestAt: number = 0;
  private pendingRequest: Promise<string> | null = null;

  constructor(entity: MarketplaceEntityCode, credentials: PerfCredentials) {
    this.entity = entity;
    this.credentials = credentials;
    this.loadStatsCache();
  }

  private async requestToken(): Promise<string> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        grant_type: 'client_credentials',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Performance API token error ${res.status}: ${body}`);
    }
    const data = (await res.json()) as TokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return data.access_token;
  }

  private async getToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) return this.accessToken;
    if (this.pendingRequest) return this.pendingRequest;
    this.pendingRequest = this.requestToken().finally(() => { this.pendingRequest = null; });
    return this.pendingRequest;
  }

  private async fetchCampaigns(): Promise<number[]> {
    const token = await this.getToken();
    const res = await fetch(CAMPAIGN_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) throw new Error(`Performance API campaigns error ${res.status}`);
    const data = (await res.json()) as CampaignListResponse;
    return (data.list || []).map((c) => c.id).filter((id) => Number.isFinite(id));
  }

  async getCampaignIds(): Promise<number[]> {
    if (this.campaigns && Date.now() < this.campaignsExpiresAt) return this.campaigns;
    this.campaigns = await this.fetchCampaigns();
    this.campaignsExpiresAt = Date.now() + 60 * 60 * 1000;
    return this.campaigns;
  }

  private buildPeriodKey(start: string, end: string): string {
    return `${start}|${end}`;
  }

  private loadStatsCache(): void {
    const path = cacheFilePath('ozon-perf-stats', this.entity);
    if (!existsSync(path)) return;
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as Array<{ periodKey: string; data: Array<{ sku: number; clicks: number; views: number }>; expiresAt: number }>;
      const now = Date.now();
      for (const entry of parsed) {
        if (entry.expiresAt <= now) continue;
        const map = new Map(entry.data.map((d) => [d.sku, { clicks: d.clicks, views: d.views }]));
        this.statsCache.set(entry.periodKey, map);
      }
    } catch { /* ignore */ }
  }

  private saveStatsCache(): void {
    ensureCacheDir();
    const now = Date.now();
    const entries: Array<{ periodKey: string; data: Array<{ sku: number; clicks: number; views: number }>; expiresAt: number }> = [];
    for (const [periodKey, skuStats] of this.statsCache) {
      const data = [...skuStats.entries()].map(([sku, s]) => ({ sku, clicks: s.clicks, views: s.views }));
      entries.push({ periodKey, data, expiresAt: now + CACHE_TTL_MS });
    }
    const tmp = cacheFilePath('ozon-perf-stats', this.entity) + '.tmp';
    writeFileSync(tmp, JSON.stringify(entries), 'utf-8');
    renameSync(tmp, cacheFilePath('ozon-perf-stats', this.entity));
  }

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < 1100) {
      await new Promise((r) => setTimeout(r, 1100 - elapsed));
    }
    this.lastRequestAt = Date.now();
  }

  async getPerformanceStats(
    skus: number[],
    startDate: string,
    endDate: string
  ): Promise<{ clicks: Map<number, number>; views: Map<number, number> }> {
    const periodKey = this.buildPeriodKey(startDate, endDate);
    const cached = this.statsCache.get(periodKey);
    if (cached) {
      const clicks = new Map<number, number>();
      const views = new Map<number, number>();
      for (const [sku, s] of cached) {
        clicks.set(sku, s.clicks);
        views.set(sku, s.views);
      }
      return { clicks, views };
    }

    const campaignIds = await this.getCampaignIds();
    if (campaignIds.length === 0) return { clicks: new Map(), views: new Map() };

    const token = await this.getToken();
    await this.rateLimit();

    const res = await fetch(STATS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ campaignIds, dateFrom: startDate, dateTo: endDate }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Performance API stats error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as ClickStatsResponse;
    const rows = data.result ?? [];

    const skuSet = new Set(skus);
    const stats = new Map<number, PerfStats>();
    for (const row of rows) {
      const sku = row.sku;
      if (!Number.isFinite(sku) || sku <= 0 || !skuSet.has(sku)) continue;
      const prev = stats.get(sku) ?? { clicks: 0, views: 0 };
      stats.set(sku, {
        clicks: prev.clicks + (row.clicks ?? 0),
        views: prev.views + (row.views ?? 0),
      });
    }

    this.statsCache.set(periodKey, stats);
    this.saveStatsCache();

    const clicks = new Map<number, number>();
    const views = new Map<number, number>();
    for (const [sku, s] of stats) {
      clicks.set(sku, s.clicks);
      views.set(sku, s.views);
    }
    return { clicks, views };
  }
}

const services = new Map<MarketplaceEntityCode, OzonPerformanceService>();

function getPerformanceService(entity: MarketplaceEntityCode): OzonPerformanceService | null {
  if (services.has(entity)) return services.get(entity)!;
  const creds = getPerfCredentials(entity);
  if (!creds) return null;
  const svc = new OzonPerformanceService(entity, creds);
  services.set(entity, svc);
  return svc;
}

export async function fetchPerformanceStats(
  entity: MarketplaceEntityCode,
  skus: number[],
  startDate: string,
  endDate: string
): Promise<{ clicks: Map<number, number>; views: Map<number, number> }> {
  const svc = getPerformanceService(entity);
  if (!svc) return { clicks: new Map(), views: new Map() };
  try {
    return await svc.getPerformanceStats(skus, startDate, endDate);
  } catch (err) {
    console.error(`[ozon-performance:${entity}] fetchPerformanceStats failed: ${err instanceof Error ? err.message : String(err)}`);
    return { clicks: new Map(), views: new Map() };
  }
}
