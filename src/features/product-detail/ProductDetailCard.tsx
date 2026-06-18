import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  X,
  Image as ImageIcon,
  Video,
  Tag,
  Zap,
  Ruler,
  Users,
  Plug,
  Battery,
  Link as LinkIcon,
  Shield,
  Globe,
  ShoppingBag,
  Package,
  BarChart3,
  Check,
} from 'lucide-react';
import type { ProductWithRelations, MediaFile, MediaLink } from '@app-types';
import { useLanguage } from '@context/LanguageContext';
import { displaySource, displayName, getCategoryColorVar } from '@utils/display';
import { categoryRequiredFields } from '@features/dashboard/dataGapsConfig';
import { getMediaUrl, hasPlayableUrl } from '@utils/media';
import { useDataSourceAPI } from '@api/dataSourceContext';
import { useToast } from '@hooks/useToast';
import {
  buildMarketplaceUrl,
  ENTITY_LABELS,
  groupMarketplaceSkusByMarketplace,
} from '@utils/marketplace';
import Modal from '@components/ui/Modal';
import Lightbox from '@components/ui/Lightbox';
import ConfirmModal from '@components/ui/ConfirmModal';
import { fetchWbSalesFunnel, type WbArticleMetrics } from '@api/wbAnalytics';

// ─── Аналитика продаж ─────────────────────────────────────────────────────
// Метрики берутся из WB Seller Analytics API через наш бэкенд-прокси
// /api/analytics/wb/sales-funnel. Бэкенд кеширует ответ 1 час.
const ANALYTICS_METRICS = [
  { key: 'orderCount',  i18nKey: 'detail.analytics.metric.orders_count',  isMoney: false },
  { key: 'orderSum',    i18nKey: 'detail.analytics.metric.orders_sum',    isMoney: true  },
  { key: 'buyoutCount', i18nKey: 'detail.analytics.metric.buyouts_count', isMoney: false },
] as const;

type MetricKey = (typeof ANALYTICS_METRICS)[number]['key'];

/** Локалезависимое форматирование чисел. */
function formatNumber(n: number, language: 'ru' | 'en'): string {
  return n.toLocaleString(language === 'ru' ? 'ru-RU' : 'en-US');
}

/** Форматирование суммы с символом валюты. */
function formatMoney(n: number, language: 'ru' | 'en'): string {
  return formatNumber(n, language) + ' ₽';
}

/** Сегодня в формате YYYY-MM-DD (UTC, чтобы совпадало с WB API). */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Сдвиг даты на deltaDays дней. */
function shiftISO(date: string, deltaDays: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** Дефолтный период: последние 7 дней (вчера..позавчера-неделю). */
function defaultPeriod(): { start: string; end: string } {
  const end = shiftISO(todayISO(), -1);
  const start = shiftISO(end, -6);
  return { start, end };
}

/** Прошлый период той же длины, сразу до start. */
function pastPeriodFor(start: string, end: string): { start: string; end: string } {
  const len = Math.round(
    (new Date(end + 'T00:00:00Z').getTime() - new Date(start + 'T00:00:00Z').getTime()) / 86400000
  );
  return {
    start: shiftISO(start, -(len + 1)),
    end: shiftISO(start, -1),
  };
}

/** Формат даты для отображения в UI: DD.MM.YYYY. */
function formatPeriodDate(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}.${m}.${y}`;
}

interface ProductDetailCardProps {
  product: ProductWithRelations;
  onClose: () => void;
  highlightedFields?: string[];
}

export default function ProductDetailCard({
  product,
  onClose,
  highlightedFields = [],
}: ProductDetailCardProps) {
  const { t, language } = useLanguage();
  const ds = useDataSourceAPI();
  const { showToast } = useToast();
  const [open, setOpen] = useState(true);
  const [nestedProduct, setNestedProduct] = useState<ProductWithRelations | null>(null);
  const [imageIndex, setImageIndex] = useState<number>(0);
  const [lightboxIndex, setLightboxIndex] = useState<number>(-1);
  const [confirmDeleteLink, setConfirmDeleteLink] = useState<MediaLink | null>(null);
  const [removedFileIds, setRemovedFileIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<'info' | 'analytics'>('info');

  // ─── Аналитика: период + состояние загрузки WB ────────────────────────
  const initialPeriod = useMemo(() => defaultPeriod(), []);
  const [periodStart, setPeriodStart] = useState(initialPeriod.start);
  const [periodEnd, setPeriodEnd] = useState(initialPeriod.end);
  // appliedPeriod — то, что реально отправлено в API. Меняется только по кнопке «Применить».
  const [appliedPeriod, setAppliedPeriod] = useState(initialPeriod);
  const [wbArticles, setWbArticles] = useState<WbArticleMetrics[]>([]);
  const [wbLoading, setWbLoading] = useState(false);
  const [wbError, setWbError] = useState<string | null>(null);
  const [wbCached, setWbCached] = useState(false);

  // WB single-артикулы товара (nmId — это числовой артикул WB)
  const wbNmIds = useMemo(() => {
    return (product.marketplaceSkus || [])
      .filter((s) => s.marketplace === 'wb' && s.kind === 'single')
      .map((s) => parseInt(s.article, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  }, [product.marketplaceSkus]);

  // Мапа nmId → entity-бейдж, для шапок колонок
  const wbNmIdToEntity = useMemo(() => {
    const map = new Map<number, import('@app-types').MarketplaceEntityCode>();
    for (const s of product.marketplaceSkus || []) {
      if (s.marketplace === 'wb' && s.kind === 'single') {
        const n = parseInt(s.article, 10);
        if (Number.isFinite(n) && n > 0) map.set(n, s.entity);
      }
    }
    return map;
  }, [product.marketplaceSkus]);

  // ─── Загрузка WB-аналитики ────────────────────────────────────────────
  // Срабатывает при переключении на вкладку «Аналитика» и при смене
  // appliedPeriod (кнопка «Применить»). Бэкенд кеширует 1 час, поэтому
  // повторные запросы в тот же период дёшевы.
  const loadWbAnalytics = useCallback(async () => {
    if (wbNmIds.length === 0) {
      setWbArticles([]);
      setWbError(null);
      return;
    }
    setWbLoading(true);
    setWbError(null);
    try {
      const res = await fetchWbSalesFunnel(wbNmIds, appliedPeriod.start, appliedPeriod.end);
      setWbArticles(res.articles);
      setWbCached(res.cached);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setWbError(msg);
      setWbArticles([]);
    } finally {
      setWbLoading(false);
    }
  }, [wbNmIds, appliedPeriod]);

  useEffect(() => {
    if (activeTab === 'analytics') {
      loadWbAnalytics();
    }
  }, [activeTab, loadWbAnalytics]);

  const applyPeriod = useCallback(() => {
    if (periodStart > periodEnd) return;
    setAppliedPeriod({ start: periodStart, end: periodEnd });
  }, [periodStart, periodEnd]);

  const tabs = useMemo(
    () => [
      { id: 'info' as const, label: t('detail.tab.info'), icon: Package },
      { id: 'analytics' as const, label: t('detail.tab.analytics'), icon: BarChart3 },
    ],
    [t]
  );

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  const handleNestedClose = useCallback(() => {
    setNestedProduct(null);
  }, []);

  const allMissing = useMemo(() => {
    const reqFields = categoryRequiredFields[product.category.code];
    if (!reqFields) return new Set<string>();
    const missing = new Set<string>();
    for (const fd of reqFields) {
      const val = product[fd.field as keyof ProductWithRelations];
      if (val == null || val === '') {
        missing.add(fd.field);
      }
    }
    return missing;
  }, [product]);

  const hl = (field: string) => {
    if (highlightedFields.includes(field)) return 'ring-1 ring-danger/40 bg-danger/[0.03]';
    if (allMissing.has(field)) return 'ring-1 ring-warning/20 bg-warning/[0.02]';
    return '';
  };

  const desc = product.description || '';
  const usp = product.usp || '';
  const tags = product.tags || [];

  const specs = [
    { icon: Zap, label: t('detail.power'), value: product.powerW ? `${product.powerW}W` : '—', field: 'powerW' },
    { icon: Battery, label: t('detail.current'), value: product.currentA ? `${product.currentA}A` : '—', field: 'currentA' },
    { icon: Zap, label: t('detail.voltage'), value: product.voltageV ? `${product.voltageV}V` : '—', field: 'voltageV' },
    { icon: Ruler, label: t('detail.length'), value: product.lengthM ? `${product.lengthM}м` : '—', field: 'lengthM' },
    { icon: Users, label: t('detail.devices'), value: product.deviceCount || '—', field: 'deviceCount' },
    { icon: LinkIcon, label: t('detail.speed'), value: product.dataTransferMbps ? `${product.dataTransferMbps} Mbps` : '—', field: 'dataTransferMbps' },
  ];

  const connections = [
    { label: t('detail.input'), value: product.connectorFemale ? displaySource(product.connectorFemale) : '—', field: 'connectorFemale' },
    { label: t('detail.output'), value: product.connectorMale ? displaySource(product.connectorMale) : '—', field: 'connectorMale' },
    { label: t('detail.protocol'), value: product.chargingProtocol ? displaySource(product.chargingProtocol) : '—', field: 'chargingProtocol' },
    { label: t('detail.connection'), value: product.connectionType || '—', field: 'connectionType' },
  ];

  const materials = [
    { label: t('detail.body'), value: product.bodyMaterial ? displayName(product.bodyMaterial) : '—', field: 'bodyMaterial' },
    { label: t('detail.wire'), value: product.wireMaterial ? displayName(product.wireMaterial) : '—', field: 'wireMaterial' },
  ];

  const mediaFiles = product.mediaFiles ?? [];
  const mediaLinks = product.mediaLinks ?? [];
  const sortedFiles = useMemo(
    () =>
      [...mediaFiles].sort((a, b) => {
        const aLink = mediaLinks.find((l) => l.fileId === a.id);
        const bLink = mediaLinks.find((l) => l.fileId === b.id);
        if (aLink?.isPrimary !== bLink?.isPrimary) return aLink?.isPrimary ? -1 : 1;
        return (aLink?.sortOrder ?? 0) - (bLink?.sortOrder ?? 0);
      }),
    [mediaFiles, mediaLinks]
  );
  const visibleFiles = useMemo(
    () => sortedFiles.filter((f) => !removedFileIds.has(f.id)),
    [sortedFiles, removedFileIds]
  );
  const clampedImageIndex = imageIndex >= visibleFiles.length ? Math.max(0, visibleFiles.length - 1) : imageIndex;
  const currentFile = visibleFiles[clampedImageIndex] ?? null;

  const singleSkus = (product.marketplaceSkus || []).filter((s) => s.kind === 'single');
  const bundleSkus = (product.marketplaceSkus || []).filter((s) => s.kind === 'bundle');
  const singleGroups = groupMarketplaceSkusByMarketplace(singleSkus);
  const bundleGroups = groupMarketplaceSkusByMarketplace(bundleSkus);

  const [copiedArticle, setCopiedArticle] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleDeleteLink = useCallback(
    async (fileId: string, variantId: string) => {
      try {
        if (ds.products.deleteMediaLink) {
          await ds.products.deleteMediaLink(fileId, variantId);
          showToast(t('media.toast.unlinked') + ' 1');
        } else {
          throw new Error('deleteMediaLink not supported');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast(msg, 'error');
      }
    },
    [ds.products, showToast, t]
  );

  const handleCopyArticle = useCallback(
    (e: React.MouseEvent, article: string) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(article).catch(() => {});
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      setCopiedArticle(article);
      copyTimerRef.current = setTimeout(() => setCopiedArticle(null), 1500);
      showToast(`${t('sku.copied')}: ${article}`, 'info');
    },
    [showToast, t]
  );

  const MarketplaceBadge = ({ marketplace }: { marketplace: 'wb' | 'ozon' }) => (
    <span
      className="inline-flex items-center justify-center w-10 sm:w-11 h-5 sm:h-6 rounded-md text-[9px] sm:text-[10px] font-semibold border"
      style={{
        background: marketplace === 'wb' ? 'var(--color-wb-bg)' : 'var(--color-ozon-bg)',
        color: marketplace === 'wb' ? 'var(--color-wb)' : 'var(--color-ozon)',
        borderColor: marketplace === 'wb' ? 'var(--color-wb-border)' : 'var(--color-ozon-border)',
      }}
    >
      {marketplace === 'wb' ? 'WB' : 'OZON'}
    </span>
  );

  const EntityBadge = ({ entity }: { entity: import('@app-types').MarketplaceEntityCode }) => (
    <span className="inline-flex items-center justify-center w-10 sm:w-11 h-5 sm:h-6 rounded-md text-[9px] sm:text-[10px] font-semibold bg-bg-tertiary text-text-secondary border border-border-subtle">
      {ENTITY_LABELS[entity]}
    </span>
  );

  const CopyableArticle = ({ article }: { article: string }) => {
    const isCopied = copiedArticle === article;
    return (
      <code
        onClick={(e) => handleCopyArticle(e, article)}
        className={`inline-flex items-center gap-1 text-[9px] sm:text-[10px] px-1 py-0.5 rounded border font-mono mt-0.5 cursor-pointer transition-all duration-150 select-none ${
          isCopied
            ? 'bg-success/10 border-success/30 text-success scale-105'
            : 'bg-accent/10 border-accent/20 text-accent hover:bg-accent/20'
        }`}
        title={isCopied ? t('sku.copied') : `${t('sku.copy')}: ${article}`}
      >
        {isCopied ? (
          <>
            <Check className="w-2.5 h-2.5" />
            <span>{t('sku.copied')}</span>
          </>
        ) : (
          article
        )}
      </code>
    );
  };

  // ─── Аналитическая вкладка ───────────────────────────────────────────
  // Реальные данные WB через /api/analytics/wb/sales-funnel. Таблица:
  // колонки по каждому WB-артикулу (бейдж юрлица + nmId) + Ozon placeholder.
  // Дельта берётся из WB-поля comparison.*Dynamic (уже в %).
  function AnalyticsTab() {
    const past = useMemo(
      () => pastPeriodFor(appliedPeriod.start, appliedPeriod.end),
      [appliedPeriod]
    );

    // Метрика → значение из выбранного артикула
    const metricValue = (art: WbArticleMetrics, key: MetricKey): number => {
      return art.selected[key];
    };
    // Метрика → динамика (%) из артикула
    const metricDynamic = (art: WbArticleMetrics, key: MetricKey): number => {
      return art.dynamics[key];
    };

    /** Рендер одной ячейки: значение + дельта. */
    const renderCell = (art: WbArticleMetrics, key: MetricKey) => {
      const val = metricValue(art, key);
      const dyn = metricDynamic(art, key);
      const metric = ANALYTICS_METRICS.find((m) => m.key === key)!;
      const formatted = metric.isMoney ? formatMoney(val, language) : formatNumber(val, language);
      const isUp = dyn > 0;
      const isFlat = dyn === 0;
      return (
        <div className="text-center px-1.5 py-1.5 rounded">
          <div className="font-mono tabular-nums text-[10px] sm:text-xs text-text-primary">
            {formatted}
          </div>
          {isFlat ? (
            <div className="text-[9px] text-text-muted mt-0.5">{t('detail.analytics.delta.flat')}</div>
          ) : (
            <div
              className={`text-[9px] mt-0.5 flex items-center justify-center gap-0.5 ${
                isUp ? 'text-success' : 'text-danger'
              }`}
            >
              {isUp ? '↑' : '↓'} {Math.abs(dyn)}% · {isUp ? t('detail.analytics.delta.up') : t('detail.analytics.delta.down')}
            </div>
          )}
        </div>
      );
    };

    // ─── Нет WB-артикулов ───
    if (wbNmIds.length === 0) {
      return (
        <div className="p-3 sm:p-4 space-y-3 sm:space-y-4">
          <div className="space-y-0.5">
            <h3 className="text-xs sm:text-sm font-semibold text-text-primary">
              {t('detail.analytics.title')}
            </h3>
            <p className="text-[10px] sm:text-xs text-text-tertiary">
              {t('detail.analytics.subtitle')}
            </p>
          </div>
          <div className="py-10 flex flex-col items-center gap-2 text-center">
            <BarChart3 className="w-8 h-8 text-text-muted" />
            <span className="text-xs text-text-tertiary">{t('detail.analytics.no_wb_articles')}</span>
          </div>
        </div>
      );
    }

    // ─── Колонки: динамически по количеству WB-артикулов ───
    // Сортируем артикулы по entity-порядку (КЮА → КАА → ДЕВ → БМС) для стабильности.
    const entityOrder: Record<string, number> = { kua: 0, kaa: 1, dev: 2, bms: 3 };
    const sortedArticles = [...wbArticles].sort((a, b) => {
      const ea = entityOrder[wbNmIdToEntity.get(a.nmId) ?? ''] ?? 99;
      const eb = entityOrder[wbNmIdToEntity.get(b.nmId) ?? ''] ?? 99;
      return ea - eb;
    });

    // Грид-шаблон: 1fr (метрика) + N колонок по 96px (WB) + 96px (Ozon)
    const wbColCount = sortedArticles.length;
    const gridTemplate = `1fr repeat(${wbColCount}, minmax(96px, 1fr)) minmax(96px, 1fr)`;

    return (
      <div className="p-3 sm:p-4 space-y-3 sm:space-y-4">
        {/* Шапка раздела */}
        <div className="space-y-0.5">
          <h3 className="text-xs sm:text-sm font-semibold text-text-primary">
            {t('detail.analytics.title')}
          </h3>
          <p className="text-[10px] sm:text-xs text-text-tertiary">
            {t('detail.analytics.subtitle')}
          </p>
        </div>

        {/* Date picker */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <label className="text-[10px] sm:text-xs text-text-tertiary">
            {t('detail.analytics.period.label')}
          </label>
          <input
            type="date"
            value={periodStart}
            max={periodEnd}
            onChange={(e) => setPeriodStart(e.target.value)}
            className="h-9 px-2 rounded-lg bg-bg-secondary border border-border-subtle text-xs text-text-primary outline-none focus:border-accent/50"
          />
          <span className="text-text-tertiary text-xs">—</span>
          <input
            type="date"
            value={periodEnd}
            min={periodStart}
            max={todayISO()}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className="h-9 px-2 rounded-lg bg-bg-secondary border border-border-subtle text-xs text-text-primary outline-none focus:border-accent/50"
          />
          <button
            onClick={applyPeriod}
            disabled={periodStart > periodEnd || (periodStart === appliedPeriod.start && periodEnd === appliedPeriod.end)}
            className="h-9 px-3 rounded-lg bg-accent/20 text-white text-xs font-medium border border-accent/40 hover:bg-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {t('detail.analytics.period.apply')}
          </button>
          <span className="text-[10px] text-text-tertiary">
            {t('detail.analytics.period.past_prefix')} {formatPeriodDate(past.start)} — {formatPeriodDate(past.end)}
          </span>
          {wbCached && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted border border-border-subtle">
              {t('detail.analytics.cached_badge')}
            </span>
          )}
        </div>

        {/* Состояния: loading / error / table */}
        {wbLoading ? (
          <div className="py-10 flex flex-col items-center gap-2">
            <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
            <span className="text-xs text-text-tertiary">{t('detail.analytics.loading')}</span>
          </div>
        ) : wbError ? (
          <div className="py-8 flex flex-col items-center gap-3 text-center">
            <span className="text-xs text-danger">{t('detail.analytics.error')}</span>
            <p className="text-[10px] text-text-tertiary max-w-md">{wbError}</p>
            <button
              onClick={loadWbAnalytics}
              className="h-9 px-3 rounded-lg bg-bg-secondary border border-border-subtle text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
            >
              {t('detail.analytics.retry')}
            </button>
          </div>
        ) : (
          <div className="glass rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <div className="min-w-[420px]">
                {/* Шапка колонок */}
                <div
                  className="grid gap-2 sm:gap-3 px-3 sm:px-4 py-2 bg-bg-tertiary/50 items-center"
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  <div className="text-[10px] sm:text-xs font-medium text-text-tertiary uppercase tracking-wider">
                    {t('detail.analytics.compare_header.metric')}
                  </div>
                  {sortedArticles.map((art) => {
                    const entity = wbNmIdToEntity.get(art.nmId);
                    return (
                      <div key={`col-${art.nmId}`} className="flex flex-col items-center gap-0.5 min-w-0">
                        {entity && (
                          <span className="inline-flex items-center justify-center h-5 px-1 rounded text-[9px] font-semibold bg-bg-tertiary text-text-secondary border border-border-subtle">
                            {ENTITY_LABELS[entity]}
                          </span>
                        )}
                        <span className="text-[9px] text-text-muted font-mono truncate" title={String(art.nmId)}>
                          {art.nmId}
                        </span>
                      </div>
                    );
                  })}
                  <div className="flex flex-col items-center gap-0.5">
                    <MarketplaceBadge marketplace="ozon" />
                    <span className="text-[9px] text-text-muted">{t('detail.analytics.ozon_soon')}</span>
                  </div>
                </div>

                {/* Строки метрик */}
                {ANALYTICS_METRICS.map((metric) => (
                  <div
                    key={metric.key}
                    className="grid gap-2 sm:gap-3 px-3 sm:px-4 py-2 items-center border-t border-border-subtle/30"
                    style={{ gridTemplateColumns: gridTemplate }}
                  >
                    <div className="text-[10px] sm:text-xs text-text-tertiary">
                      {t(metric.i18nKey)}
                    </div>
                    {sortedArticles.map((art) => (
                      <div key={`cell-${metric.key}-${art.nmId}`}>
                        {renderCell(art, metric.key)}
                      </div>
                    ))}
                    <div className="text-center px-1.5 py-1.5 rounded text-text-muted font-mono tabular-nums text-[10px] sm:text-xs">
                      {t('detail.analytics.value_placeholder')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderMediaPreview(file: MediaFile, size: 'sm' | 'md' | 'lg' = 'md') {
    const url = getMediaUrl(file.url);
    const iconSize =
      size === 'lg'
        ? 'w-10 h-10 sm:w-12 sm:h-12'
        : size === 'sm'
          ? 'w-3 h-3 sm:w-3.5 sm:h-3.5'
          : 'w-4 h-4 sm:w-5 sm:h-5';

    if (!hasPlayableUrl(file)) {
      return file.mimeType.startsWith('image/') ? (
        <ImageIcon className={`${iconSize} text-text-muted`} />
      ) : (
        <Video className={`${iconSize} text-text-muted`} />
      );
    }

    if (file.mimeType.startsWith('image/')) {
      return <img src={url} alt={file.originalName} className="w-full h-full object-contain" loading="lazy" />;
    }

    return <video src={url} className="w-full h-full object-cover" muted playsInline preload="metadata" />;
  }

  const modalContent = (
    <>
      <div className="flex items-start justify-between p-3 sm:p-4 border-b border-border-subtle bg-bg-secondary/50 sticky top-0 z-10">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <code className="text-[11px] sm:text-sm text-accent px-1.5 sm:px-2 py-0.5 rounded bg-accent/10 border border-accent/20">
              {product.sku}
            </code>
          </div>
          <h2 className="text-sm sm:text-base font-semibold text-text-primary mb-0.5 leading-snug line-clamp-2">
            {product.productName}
          </h2>
          <div className="flex items-center gap-1.5 text-[10px] sm:text-[11px] text-text-tertiary flex-wrap">
            <span style={{ color: getCategoryColorVar(product.category) }}>
              {displaySource(product.category)}
            </span>
            <span>·</span>
            <span className="text-text-secondary">{displaySource(product.model)}</span>
            {product.color && (
              <>
                <span>·</span>
                <div className="flex items-center gap-1">
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{
                      background: product.color.color === 'gradient'
                        ? 'conic-gradient(in hsl longer hue, red, red)'
                        : product.color.color,
                      border: product.color.color === 'gradient' ? 'none' : '1px solid var(--color-border-subtle)',
                    }}
                  />
                  <span>{displaySource(product.color)}</span>
                </div>
              </>
            )}
          </div>
        </div>
        <button
          onClick={handleClose}
          aria-label="Close"
          className="h-8 w-8 sm:h-9 sm:w-9 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors cursor-pointer self-start flex items-center justify-center flex-shrink-0"
        >
          <X className="w-4 h-4 sm:w-5 sm:h-5" />
        </button>
      </div>

      {/* Tabs: sticky под шапкой, переключают «Информация» / «Аналитика» */}
      <div className="sticky top-0 z-10 bg-bg-secondary/50 backdrop-blur-sm border-b border-border-subtle px-3 sm:px-4 py-2">
        <div className="flex items-center gap-1 p-0.5 rounded-xl bg-bg-secondary border border-border-subtle w-fit">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`h-9 px-3 rounded-lg flex items-center gap-1.5 text-xs transition-colors cursor-pointer ${
                activeTab === tab.id
                  ? 'bg-accent/25 text-white border border-accent/40'
                  : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary border border-transparent'
              }`}
            >
              <tab.icon className="w-3.5 h-3.5" />
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {activeTab === 'info' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-0">
          <div className="lg:col-span-2 p-3 sm:p-4 space-y-3 sm:space-y-4 lg:border-r border-border-subtle">
            <div className="space-y-2">
              <h3 className="text-[10px] sm:text-xs font-medium text-text-tertiary flex items-center gap-1.5">
                <ImageIcon className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                {t('detail.media')}
                {currentFile && (
                  <span className="text-[9px] text-text-muted ml-auto">
                    {imageIndex + 1}/{visibleFiles.length}
                  </span>
                )}
              </h3>
              {currentFile ? (
                <div
                  className="rounded-xl bg-bg-tertiary border border-border-subtle flex items-center justify-center overflow-hidden cursor-pointer"
                  onClick={() => setLightboxIndex(imageIndex)}
                >
                  <div className="aspect-video w-full flex items-center justify-center bg-bg-tertiary">
                    {renderMediaPreview(currentFile, 'lg')}
                  </div>
                </div>
              ) : (
                <div className="aspect-video rounded-xl bg-bg-tertiary/50 border border-border-subtle border-dashed flex items-center justify-center">
                  <div className="flex flex-col items-center gap-1">
                    <ImageIcon className="w-6 h-6 text-text-muted" />
                    <span className="text-[10px] sm:text-xs text-text-tertiary">{t('detail.no_media')}</span>
                  </div>
                </div>
              )}
              {visibleFiles.length > 1 && (
                <div className="flex gap-1.5 overflow-x-auto pb-1">
                  {visibleFiles.map((f, i) => {
                    const url = getMediaUrl(f.url);
                    const isActive = i === imageIndex;
                    const link = mediaLinks.find((l) => l.fileId === f.id);
                    return (
                      <button
                        key={f.id}
                        onClick={() => setImageIndex(i)}
                        className={`relative w-10 h-10 sm:w-12 sm:h-12 rounded-lg overflow-hidden border flex-shrink-0 flex items-center justify-center transition-[colors,opacity,transform,box-shadow] duration-150 ${
                          isActive ? 'border-accent ring-1 ring-accent/30' : 'border-border-subtle hover:border-border-default'
                        }`}
                        aria-label={`${t('detail.media')} ${i + 1}`}
                      >
                        {hasPlayableUrl(f) ? (
                          f.mimeType.startsWith('image/') ? (
                            <img src={url} alt={f.originalName} className="w-full h-full object-cover" loading="lazy" />
                          ) : (
                            <video src={url} className="w-full h-full object-cover" muted playsInline preload="metadata" />
                          )
                        ) : f.mimeType.startsWith('image/') ? (
                          <ImageIcon className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-text-muted" />
                        ) : (
                          <Video className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-text-muted" />
                        )}
                        {link?.isPrimary && <div className="absolute top-0 left-0 w-full h-full ring-1 ring-warning/30 rounded-lg pointer-events-none" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {desc && (
              <div className="space-y-1.5">
                <h3 className="text-[10px] sm:text-xs font-medium text-text-tertiary flex items-center gap-1.5">
                  <Globe className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                  {t('detail.description')}
                </h3>
                <p className="text-[11px] sm:text-xs text-text-secondary leading-relaxed">{desc}</p>
              </div>
            )}
            {usp && (
              <div className="space-y-1.5">
                <h3 className="text-[10px] sm:text-xs font-medium text-text-tertiary flex items-center gap-1.5">
                  <Shield className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                  {t('detail.benefits')}
                </h3>
                <p className="text-[11px] sm:text-xs text-text-secondary leading-relaxed">{usp}</p>
              </div>
            )}
            {tags.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="text-[10px] sm:text-xs font-medium text-text-tertiary flex items-center gap-1.5">
                  <Tag className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                  {t('detail.tags')}
                </h3>
                <div className="flex flex-wrap gap-1">
                  {tags.map((tag, i) => (
                    <span key={i} className="text-[9px] sm:text-[10px] px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-full bg-bg-tertiary text-text-secondary border border-border-subtle">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {(singleSkus.length > 0 || bundleSkus.length > 0) && (
              <div className="space-y-3">
                <h3 className="text-[10px] sm:text-xs font-medium text-text-tertiary flex items-center gap-1.5">
                  <ShoppingBag className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                  {t('detail.marketplaces')}
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* ─── Single: выставлен как товар ─── */}
                  {singleSkus.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[9px] sm:text-[10px] text-text-tertiary">{t('detail.listed_as_product')}</p>
                      <div className="space-y-2">
                        {(['wb', 'ozon'] as const).map((mp) => {
                          const items = singleGroups[mp];
                          if (items.length === 0) return null;
                          return (
                            <div key={`single-${mp}`} className="space-y-1">
                              {items.map((sku, i) => (
                                <a
                                  key={`single-${mp}-${i}`}
                                  href={buildMarketplaceUrl(mp, sku.article)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="flex items-center justify-between gap-2 p-1.5 sm:p-2 rounded-lg bg-bg-tertiary border border-border-subtle hover:bg-bg-hover hover:border-border-default transition-colors"
                                >
                                  <div className="min-w-0 flex-1">
                                    <p className="text-[10px] sm:text-xs text-text-primary truncate" title={sku.title}>
                                      {sku.title}
                                    </p>
                                    <CopyableArticle article={sku.article} />
                                  </div>
                                  <div className="flex items-center gap-1 shrink-0">
                                    <EntityBadge entity={sku.entity} />
                                    <MarketplaceBadge marketplace={mp} />
                                  </div>
                                </a>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* ─── Bundle: входит в комплекты ─── */}
                  {bundleSkus.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[9px] sm:text-[10px] text-text-tertiary">{t('detail.included_in_bundles')}</p>
                      <div className="space-y-2">
                        {(['wb', 'ozon'] as const).map((mp) => {
                          const items = bundleGroups[mp];
                          if (items.length === 0) return null;
                          return (
                            <div key={`bundle-${mp}`} className="space-y-1">
                              {items.map((sku, i) => (
                                <a
                                  key={`bundle-${mp}-${i}`}
                                  href={buildMarketplaceUrl(mp, sku.article)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="flex items-center justify-between gap-2 p-1.5 sm:p-2 rounded-lg bg-bg-tertiary border border-border-subtle hover:bg-bg-hover hover:border-border-default transition-colors"
                                >
                                  <div className="min-w-0 flex-1">
                                    <p className="text-[10px] sm:text-xs text-text-primary truncate" title={sku.title}>
                                      {sku.title}
                                    </p>
                                    <CopyableArticle article={sku.article} />
                                  </div>
                                  <div className="flex items-center gap-1 shrink-0">
                                    <EntityBadge entity={sku.entity} />
                                    <MarketplaceBadge marketplace={mp} />
                                  </div>
                                </a>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="p-3 sm:p-4 space-y-3 sm:space-y-4 bg-bg-tertiary/30">
            {product.isKit && product.kitComponents && product.kitComponents.length > 0 ? (
              <div className="space-y-3">
                <h3 className="text-[10px] sm:text-xs font-medium text-text-secondary flex items-center gap-1.5">
                  <Package className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                  Комплект содержит:
                </h3>
                <div className="space-y-2">
                  {product.kitComponents.map((comp, idx) => {
                    const compProduct = comp.product;
                    const compHl = (field: string) => {
                      const reqFields = categoryRequiredFields[compProduct.category.code];
                      if (!reqFields) return '';
                      for (const fd of reqFields) {
                        if (fd.field === field) {
                          const val = compProduct[field as keyof ProductWithRelations];
                          if (val == null || val === '') return 'ring-1 ring-warning/30 bg-warning/[0.03]';
                        }
                      }
                      return '';
                    };
                    const compSpecs = [
                      { icon: Zap, label: t('detail.power'), value: compProduct.powerW ? `${compProduct.powerW}W` : '—', field: 'powerW' },
                      { icon: Battery, label: t('detail.current'), value: compProduct.currentA ? `${compProduct.currentA}A` : '—', field: 'currentA' },
                      { icon: Zap, label: t('detail.voltage'), value: compProduct.voltageV ? `${compProduct.voltageV}V` : '—', field: 'voltageV' },
                      { icon: Ruler, label: t('detail.length'), value: compProduct.lengthM ? `${compProduct.lengthM}м` : '—', field: 'lengthM' },
                      { icon: Users, label: t('detail.devices'), value: compProduct.deviceCount || '—', field: 'deviceCount' },
                      { icon: LinkIcon, label: t('detail.speed'), value: compProduct.dataTransferMbps ? `${compProduct.dataTransferMbps} Mbps` : '—', field: 'dataTransferMbps' },
                    ];
                    return (
                      <div key={idx} className="rounded-lg border border-border-subtle bg-bg-tertiary/50 p-2 sm:p-3 space-y-2">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] sm:text-xs font-medium text-text-primary cursor-pointer hover:text-accent transition-colors" onClick={() => setNestedProduct(compProduct)}>
                              {compProduct.productName}
                            </span>
                            <span className="text-[9px] sm:text-[10px] text-text-secondary">×{comp.quantity}</span>
                            <span className="text-[9px] sm:text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-secondary border border-border-subtle">
                              {displaySource(compProduct.category)}
                            </span>
                          </div>
                          <code className="text-[9px] text-accent px-1 py-0.5 rounded bg-accent/10 border border-accent/20 font-mono w-fit">{compProduct.sku}</code>
                        </div>
                        <div className="grid grid-cols-2 gap-1.5">
                          {compSpecs.map((spec, i) => (
                            <div key={i} className={`p-1.5 sm:p-2 rounded-lg bg-bg-tertiary border border-border-subtle ${compHl(spec.field)}`}>
                              <div className="flex items-center gap-1 mb-0.5">
                                <spec.icon className="w-2.5 h-2.5 sm:w-3 sm:h-3 text-text-muted" />
                                <span className="text-[9px] sm:text-[10px] text-text-tertiary">{spec.label}</span>
                              </div>
                              <p className="text-[10px] sm:text-xs font-medium text-text-primary">{spec.value}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <h3 className="text-[10px] sm:text-xs font-medium text-text-tertiary flex items-center gap-1.5">
                    <Zap className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                    {t('detail.specifications')}
                  </h3>
                  <div className="grid grid-cols-2 gap-1.5">
                    {specs.map((spec, i) => (
                      <div key={i} className={`p-1.5 sm:p-2 rounded-lg bg-bg-tertiary border border-border-subtle ${hl(spec.field)}`}>
                        <div className="flex items-center gap-1 mb-0.5">
                          <spec.icon className="w-2.5 h-2.5 sm:w-3 sm:h-3 text-text-muted" />
                          <span className="text-[9px] sm:text-[10px] text-text-tertiary">{spec.label}</span>
                        </div>
                        <p className="text-[10px] sm:text-xs font-medium text-text-primary">{spec.value}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <h3 className="text-[10px] sm:text-xs font-medium text-text-tertiary flex items-center gap-1.5">
                    <Plug className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                    {t('detail.connections')}
                  </h3>
                  <div className="space-y-1">
                    {connections.map((conn, i) => (
                      <div key={i} className={`flex justify-between items-center p-1.5 sm:p-2 rounded-lg bg-bg-tertiary border border-border-subtle ${hl(conn.field)}`}>
                        <span className="text-[9px] sm:text-[10px] text-text-tertiary">{conn.label}</span>
                        <span className="text-[10px] sm:text-xs font-medium text-text-primary">{conn.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <h3 className="text-[10px] sm:text-xs font-medium text-text-tertiary flex items-center gap-1.5">
                    <Shield className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                    {t('detail.materials')}
                  </h3>
                  <div className="space-y-1">
                    {materials.map((mat, i) => (
                      <div key={i} className={`flex justify-between items-center p-1.5 sm:p-2 rounded-lg bg-bg-tertiary border border-border-subtle ${hl(mat.field)}`}>
                        <span className="text-[9px] sm:text-[10px] text-text-tertiary">{mat.label}</span>
                        <span className="text-[10px] sm:text-xs font-medium text-text-primary">{mat.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {product.supplier && (
                  <div className="space-y-2">
                    <h3 className="text-[10px] sm:text-xs font-medium text-text-tertiary flex items-center gap-1.5">
                      <Globe className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                      {t('detail.supplier')}
                    </h3>
                    <div className={`p-2 sm:p-2.5 rounded-lg bg-bg-tertiary border border-border-subtle ${hl('supplier')}`}>
                      <p className="text-[10px] sm:text-xs font-medium text-text-primary">{product.supplier.name}</p>
                      {product.supplier.code !== '-' && (
                        <p className="text-[9px] sm:text-[10px] text-text-tertiary mt-0.5">Code: {product.supplier.code}</p>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        )}

        {activeTab === 'analytics' && (
          <AnalyticsTab />
        )}
      </div>

      {/* Lightbox */}
      <Lightbox
        open={lightboxIndex >= 0}
        files={visibleFiles}
        currentIndex={lightboxIndex}
        onClose={() => setLightboxIndex(-1)}
        onChangeIndex={setLightboxIndex}
        onDelete={(fileId) => {
          const link = mediaLinks.find((l) => l.fileId === fileId);
          if (link) setConfirmDeleteLink(link);
        }}
      />

      {/* Confirm Unlink */}
      <ConfirmModal
        open={!!confirmDeleteLink}
        title={t('media.confirm_unlink_title')}
        description={t('media.confirm_unlink_desc')}
        variant="warning"
        onConfirm={() => {
          if (confirmDeleteLink) {
            handleDeleteLink(confirmDeleteLink.fileId, confirmDeleteLink.variantId);
            setRemovedFileIds((prev) => new Set(prev).add(confirmDeleteLink.fileId));
            setLightboxIndex(-1);
            setConfirmDeleteLink(null);
          }
        }}
        onCancel={() => setConfirmDeleteLink(null)}
      />
    </>
  );

  return (
    <>
      <Modal
        variant="auto"
        width="lg"
        open={open}
        onClose={handleClose}
        onExitComplete={onClose}
        showCloseButton={false}
        height="clamp(70dvh, 80dvh, 95dvh)"
        pinned
        className="sm:!max-w-[clamp(600px,75vw,1400px)] sm:rounded-2xl"
        contentClassName="p-0 flex flex-col"
      >
        {modalContent}
      </Modal>
      {nestedProduct && <ProductDetailCard product={nestedProduct} onClose={handleNestedClose} />}
    </>
  );
}
