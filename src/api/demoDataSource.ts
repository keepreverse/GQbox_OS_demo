// ─── Demo-mode DataSource (JSON-файлы на сервере) ──────────────────────────
// Ходит в /api/demo/* — это Express-роуты, которые читают/пишут
// server/data/*.json. Никакого PostgreSQL.

import { request, ApiError, API_BASE } from './client';
import {
  DICT_TYPE_NAMES,
  hydrateProduct,
  asCategory,
  asColor,
  asConnector,
  asChargingProtocol,
  asMaterial,
  asModel,
  asSupplier,
  type DataSource,
  type DictionariesAPI,
  type InspectorAPI,
  type NotificationsAPI,
  type ProductsAPI,
  type RawDictItem,
  type SettingsAPI,
  type UploadMediaMeta,
  type UploadMediaResult,
  type UsersAPI,
} from './dataSource';
import type {
  AppNotification,
  CategoryAttribute,
  NamingTemplate,
  MediaFile,
  MediaLink,
  ProductWithRelations,
  RawProduct,
} from '@app-types';

const API_PREFIX = '/api/demo';

// ─── Helpers ──────────────────────────────────────────────────────────────

async function fetchDictionaries(): Promise<Record<string, RawDictItem[]>> {
  const out: Record<string, RawDictItem[]> = {};
  await Promise.all(
    DICT_TYPE_NAMES.map(async (name) => {
      out[name] = await request<RawDictItem[]>(`${API_PREFIX}/dictionaries/${name}`);
    })
  );
  return out;
}

// ─── DemoDataSource ────────────────────────────────────────────────────────

export function createDemoDataSource(): DataSource {
  // In-memory кэш
  let rawProducts: RawProduct[] = [];
  let rawKitComponents: import('@app-types').RawKitComponent[] = [];
  let rawMediaFiles: MediaFile[] = [];
  let rawMediaLinks: MediaLink[] = [];
  const dicts: Record<string, RawDictItem[]> = {
    categories: [],
    models: [],
    colors: [],
    suppliers: [],
    connectors: [],
    chargingProtocols: [],
    materials: [],
  };
  const listeners = new Set<(topic?: string) => void>();
  let isReady = false;
  let error: string | null = null;
  let batchCount = 0;

  function notify(topic?: string): void {
    if (batchCount > 0) return;
    listeners.forEach((fn) => fn(topic));
  }

  function buildHydrated(): ProductWithRelations[] {
    const categories = dicts.categories.map(asCategory);
    const models = dicts.models.map(asModel);
    const colors = dicts.colors.map(asColor);
    const suppliers = dicts.suppliers.map(asSupplier);
    const connectors = dicts.connectors.map(asConnector);
    const materials = dicts.materials.map(asMaterial);
    const chargingProtocols = dicts.chargingProtocols.map(asChargingProtocol);
    const total = rawProducts.length;
    const all = rawProducts.map((raw, i) =>
      hydrateProduct(
        raw,
        i,
        total,
        { categories, models, colors, suppliers, connectors, materials, chargingProtocols },
        rawMediaFiles,
        rawMediaLinks,
        raw.marketplaceSkus ?? []
      )
    );
    // Attach kit components to kit products
    const productMap = new Map(all.map((p) => [p.id, p]));
    for (const product of all) {
      if (product.isKit) {
        const comps = rawKitComponents
          .filter((k) => k.kitId === product.id)
          .map((k) => {
            const compProduct = productMap.get(k.componentId);
            return compProduct ? { product: compProduct, quantity: k.quantity } : null;
          })
          .filter(Boolean) as { product: ProductWithRelations; quantity: number }[];
        product.kitComponents = comps;
      }
    }
    return all;
  }

  // ─── Dictionaries API ──────────────────────────────────────────────────
  const dictionaries: DictionariesAPI = {
    get categories() {
      return dicts.categories.map(asCategory);
    },
    get models() {
      return dicts.models.map(asModel);
    },
    get colors() {
      return dicts.colors.map(asColor);
    },
    get suppliers() {
      return dicts.suppliers.map(asSupplier);
    },
    get connectors() {
      return dicts.connectors.map(asConnector);
    },
    get chargingProtocols() {
      return dicts.chargingProtocols.map(asChargingProtocol);
    },
    get materials() {
      return dicts.materials.map(asMaterial);
    },
    get attributes(): CategoryAttribute[] {
      return [];
    },
    get namingTemplates(): NamingTemplate[] {
      return [];
    },
    byId(type, id) {
      return dicts[type]?.find((d) => d.id === id);
    },
    getAll(type) {
      return dicts[type] ?? [];
    },
    async add(type, item) {
      await request<RawDictItem>(`${API_PREFIX}/dictionaries/${type}`, {
        method: 'POST',
        body: JSON.stringify(item),
      });
      dicts[type] = [...(dicts[type] ?? []), item];
      notify('dictionaries');
    },
    async update(type, id, patch) {
      await request<RawDictItem>(`${API_PREFIX}/dictionaries/${type}/${id}`, {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      const list = dicts[type] ?? [];
      const idx = list.findIndex((d) => d.id === id);
      if (idx !== -1) list[idx] = { ...list[idx], ...patch };
      notify('dictionaries');
    },
    async remove(type, id) {
      await request<unknown>(`${API_PREFIX}/dictionaries/${type}/${id}`, {
        method: 'DELETE',
      });
      dicts[type] = (dicts[type] ?? []).filter((d) => d.id !== id);
      notify('dictionaries');
    },
  };

  // ─── Products API ──────────────────────────────────────────────────────
  const products: ProductsAPI = {
    get list(): ProductWithRelations[] {
      return buildHydrated();
    },
    byId(id) {
      const raw = rawProducts.find((p) => p.id === id);
      if (!raw) return undefined;
      const all = buildHydrated();
      return all.find((p) => p.id === id);
    },
    bySku(sku) {
      const raw = rawProducts.find((p) => p.sku === sku);
      if (!raw) return undefined;
      const all = buildHydrated();
      return all.find((p) => p.sku === sku);
    },
    byCategory(categoryCode) {
      return buildHydrated().filter((p) => p.category?.code === categoryCode);
    },
    search(query) {
      const q = query.toLowerCase();
      return buildHydrated().filter(
        (p) =>
          p.sku.toLowerCase().includes(q) ||
          p.productName.toLowerCase().includes(q) ||
          (p.category?.name_source ?? '').toLowerCase().includes(q) ||
          (p.model?.name_source ?? '').toLowerCase().includes(q)
      );
    },
    async create(raw) {
      const created = await request<RawProduct>(`${API_PREFIX}/products`, {
        method: 'POST',
        body: JSON.stringify(raw),
      });
      rawProducts = [...rawProducts, created];
      notify('products');
      const all = buildHydrated();
      return all.find((p) => p.id === created.id) ?? created as unknown as ProductWithRelations;
    },
    async update(id, patch) {
      const updated = await request<RawProduct>(`${API_PREFIX}/products/${id}`, {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      rawProducts = rawProducts.map((p) => (p.id === id ? updated : p));
      notify('products');
      const all = buildHydrated();
      return all.find((p) => p.id === id) ?? updated as unknown as ProductWithRelations;
    },
    async remove(id) {
      await request<unknown>(`${API_PREFIX}/products/${id}`, { method: 'DELETE' });
      rawProducts = rawProducts.filter((p) => p.id !== id);
      rawKitComponents = rawKitComponents.filter((k) => k.kitId !== id);
      rawMediaLinks = rawMediaLinks.filter((l) => l.variantId !== id);
      notify('products');
    },
    async getKitComponents(kitId) {
      const rows = await request<import('@app-types').RawKitComponent[]>(`${API_PREFIX}/kit-components/${kitId}`);
      rawKitComponents = rawKitComponents.filter((k) => k.kitId !== kitId).concat(rows);
      notify('products');
      const all = buildHydrated();
      const kit = all.find((p) => p.id === kitId);
      return kit?.kitComponents?.map((c) => c.product) ?? [];
    },
    async addKitComponent(kitId, componentId, quantity = 1) {
      await request<import('@app-types').RawKitComponent>(`${API_PREFIX}/kit-components/${kitId}`, {
        method: 'POST',
        body: JSON.stringify({ componentId, quantity }),
      });
      const existingIdx = rawKitComponents.findIndex((k) => k.kitId === kitId && k.componentId === componentId);
      if (existingIdx !== -1) {
        rawKitComponents[existingIdx] = { ...rawKitComponents[existingIdx], quantity };
      } else {
        rawKitComponents.push({ kitId, componentId, quantity, sortOrder: 0 });
      }
      notify('products');
    },
    async removeKitComponent(kitId, componentId) {
      await request<unknown>(`${API_PREFIX}/kit-components/${kitId}/${componentId}`, { method: 'DELETE' });
      rawKitComponents = rawKitComponents.filter((k) => !(k.kitId === kitId && k.componentId === componentId));
      notify('products');
    },

    // ─── Media ──────────────────────────────────────────────────────────
    getAllMedia() {
      const linksByFile = new Map<string, string[]>();
      for (const l of rawMediaLinks) {
        const arr = linksByFile.get(l.fileId) ?? [];
        arr.push(l.variantId);
        linksByFile.set(l.fileId, arr);
      }
      return rawMediaFiles.map((f) => ({
        ...f,
        linkedSkus: linksByFile.get(f.id) ?? [],
      }));
    },
    getMediaForVariant(variantId) {
      const fileIds = new Set(
        rawMediaLinks
          .filter((l) => l.variantId === variantId)
          .sort((a, b) => {
            if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
            return a.sortOrder - b.sortOrder;
          })
          .map((l) => l.fileId)
      );
      return Array.from(fileIds)
        .map((id) => rawMediaFiles.find((f) => f.id === id))
        .filter(Boolean) as MediaFile[];
    },
    getAllMediaLinks() {
      return [...rawMediaLinks];
    },
    async uploadMedia(file: File, meta: UploadMediaMeta): Promise<UploadMediaResult> {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('variantIds', JSON.stringify(meta.variantIds));
      if (meta.isPrimary) fd.append('isPrimary', 'true');
      const localPreviewUrl = URL.createObjectURL(file);
      try {
        const res = await fetch(`${API_BASE}${API_PREFIX}/media`, {
          method: 'POST',
          body: fd,
        });
        if (!res.ok) {
          URL.revokeObjectURL(localPreviewUrl);
          const text = await res.text();
          throw new ApiError(text || `HTTP ${res.status}`, res.status);
        }
        const { file: mediaFile, links }: { file: MediaFile; links: MediaLink[] } = await res.json();
        rawMediaFiles = [...rawMediaFiles, mediaFile];
        // Re-fetch all links to pick up updated sortOrders from server
        rawMediaLinks = await request<MediaLink[]>(`${API_PREFIX}/media/links`);
        notify('products');
        return { file: mediaFile, links, localPreviewUrl };
      } catch (err) {
        URL.revokeObjectURL(localPreviewUrl);
        throw err;
      }
    },
    async deleteMedia(fileId) {
      await request<unknown>(`${API_PREFIX}/media/${fileId}`, { method: 'DELETE' });
      rawMediaFiles = rawMediaFiles.filter((f) => f.id !== fileId);
      rawMediaLinks = rawMediaLinks.filter((l) => l.fileId !== fileId);
      notify('products');
    },
    async deleteAllMedia() {
      await request<unknown>(`${API_PREFIX}/media`, { method: 'DELETE' });
      rawMediaFiles = [];
      rawMediaLinks = [];
      notify('products');
    },
    async deleteMediaLink(fileId, variantId) {
      await request<unknown>(`${API_PREFIX}/media/link/${fileId}/${variantId}`, { method: 'DELETE' });
      rawMediaLinks = rawMediaLinks.filter((l) => !(l.fileId === fileId && l.variantId === variantId));
      // Auto-delete orphaned files (no remaining links to any product)
      if (!rawMediaLinks.some((l) => l.fileId === fileId)) {
        await request<unknown>(`${API_PREFIX}/media/${fileId}`, { method: 'DELETE' }).catch(() => {});
        rawMediaFiles = rawMediaFiles.filter((f) => f.id !== fileId);
      }
      notify('products');
    },
    async setMediaPrimary(fileId, variantId) {
      const updated = await request<MediaLink>(`${API_PREFIX}/media/${fileId}/primary/${variantId}`, {
        method: 'PATCH',
      });
      rawMediaLinks = rawMediaLinks.map((l) => {
        if (l.variantId === variantId) {
          return { ...l, isPrimary: l.fileId === fileId };
        }
        return l;
      });
      notify('products');
      return updated;
    },
  };

  // ─── Notifications API ────────────────────────────────────────────────
  let notificationsCache: AppNotification[] = [];

  // ─── Users API ─────────────────────────────────────────────────────────
  // User management is only available in dev mode; demo returns empty data.
  const users: UsersAPI = {
    get list() {
      return [];
    },
    async create() {
      throw new Error('User management is only available in Developer Mode');
    },
    async update() {
      throw new Error('User management is only available in Developer Mode');
    },
    async remove() {
      throw new Error('User management is only available in Developer Mode');
    },
  };

  const notifications: NotificationsAPI = {
    get list() {
      return notificationsCache;
    },
    get unreadCount() {
      return notificationsCache.filter((n) => n.unread).length;
    },
    async add(n) {
      const created = await request<AppNotification>(`${API_PREFIX}/notifications`, {
        method: 'POST',
        body: JSON.stringify(n),
      });
      notificationsCache = [created, ...notificationsCache];
      notify('notifications');
    },
    async markRead(id) {
      await request<unknown>(`${API_PREFIX}/notifications/${id}`, { method: 'PATCH' });
      const n = notificationsCache.find((x) => x.id === id);
      if (n) n.unread = false;
      notify('notifications');
    },
    async markAllRead() {
      if (notificationsCache.filter((n) => n.unread).length === 0) return;
      await request<unknown>(`${API_PREFIX}/notifications/mark-all-read`, { method: 'PATCH' });
      for (const n of notificationsCache) n.unread = false;
      notify('notifications');
    },
    async remove(id) {
      await request<unknown>(`${API_PREFIX}/notifications/${id}`, { method: 'DELETE' });
      notificationsCache = notificationsCache.filter((x) => x.id !== id);
      notify('notifications');
    },
    async clear() {
      await request<unknown>(`${API_PREFIX}/notifications`, { method: 'DELETE' });
      notificationsCache = [];
      notify('notifications');
    },
  };

  // ─── Settings API ──────────────────────────────────────────────────────
  const settings: SettingsAPI = {
    async reset() {
      await request<{ ok: boolean }>(`${API_PREFIX}/reset`, { method: 'POST' });
      await refresh();
    },
    async seed() {
      throw new Error('Seed is only available in dev mode (PostgreSQL).');
    },
    async exportToFile() {
      const bundle = await request<unknown>(`${API_PREFIX}/export`);
      const text = JSON.stringify(bundle, null, 2);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `gqbox-demo-${date}.json`;
      triggerDownload(text, filename);
      return filename;
    },
    async importFromFile(text) {
      const bundle = JSON.parse(text);
      await request<{ ok: boolean }>(`${API_PREFIX}/import`, {
        method: 'POST',
        body: JSON.stringify(bundle),
      });
      await refresh();
    },
  };

  async function refresh(): Promise<void> {
    try {
      const [rawProductsNew, dictsNew, notifs, kitComps, mediaFiles, mediaLinks] = await Promise.all([
        request<RawProduct[]>(`${API_PREFIX}/products`),
        fetchDictionaries(),
        request<AppNotification[]>(`${API_PREFIX}/notifications`).catch(() => [] as AppNotification[]),
        request<import('@app-types').RawKitComponent[]>(`${API_PREFIX}/kit-components`).catch(() => [] as import('@app-types').RawKitComponent[]),
        request<MediaFile[]>(`${API_PREFIX}/media`).catch(() => [] as MediaFile[]),
        request<MediaLink[]>(`${API_PREFIX}/media/links`).catch(() => [] as MediaLink[]),
      ]);
      rawProducts = rawProductsNew;
      rawKitComponents = kitComps;
      rawMediaFiles = mediaFiles;
      rawMediaLinks = mediaLinks;
      for (const name of DICT_TYPE_NAMES) {
        dicts[name] = dictsNew[name] ?? [];
      }
      notificationsCache = notifs;
      isReady = true;
      error = null;
    } catch (e) {
      error = e instanceof ApiError ? e.message : (e as Error).message;
      isReady = false;
    }
    notify('all');
  }

  const inspector: InspectorAPI = {
    get available() { return false; },
    async listTables() { return []; },
    async dumpTable() { return { columns: [], rows: [], rowCount: 0, truncated: false }; },
    async runQuery() { return { columns: [], rows: [], rowCount: 0, truncated: false }; },
  };

  return {
    mode: 'demo',
    get isReady() {
      return isReady;
    },
    get error() {
      return error;
    },
    products,
    dictionaries,
    notifications,
    settings,
    users,
    inspector,
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify,
    beginBatch() { batchCount++; },
    endBatch() {
      batchCount = Math.max(0, batchCount - 1);
      if (batchCount === 0) notify('all');
    },
  };
}

function triggerDownload(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
