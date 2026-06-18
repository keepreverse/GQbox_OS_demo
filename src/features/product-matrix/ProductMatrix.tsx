import { useState, useMemo, useEffect, useCallback, useRef, useDeferredValue } from 'react';
// Framer Motion removed to prevent forced reflow on data mutations
import {
  Download,
  Eye,
  X,
  Cable,
  Zap,
  Wifi,
  Car,
  Headphones,
  ArrowLeftRight,
  Magnet,
  Sparkles,
  Navigation,
  Package,
  Monitor,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  SlidersHorizontal,
  List,
  Check,
} from 'lucide-react';
import { useDataSourceVersion } from '@api/dataSourceContext';
import type { ProductWithRelations, MatrixFilters } from '@app-types';
import { useLanguage } from '@context/LanguageContext';
import { displayProductName, displaySource, getCategoryColorVar } from '@utils/display';
import { ENTITY_LABELS, ENTITY_ORDER, getProductMarketplaceSearchText } from '@utils/marketplace';
import type { MarketplaceEntityCode } from '@app-types';
import { categoryRequiredFields } from '@features/dashboard/dataGapsConfig';
import ProductDetailCard from '@features/product-detail/ProductDetailCard';
import { ResponsiveTable } from '@components/ui/ResponsiveTable';
import type { Column } from '@app-types/table';

const categoryIcons: Record<string, React.ElementType> = {
  cable: Cable,
  szu: Zap,
  bzu: Wifi,
  azu: Car,
  headphones: Headphones,
  adapter: ArrowLeftRight,
  pin: Magnet,
  holder: Navigation,
  case: Sparkles,
  kit: Package,
  blogo: Monitor,
};

interface ProductMatrixProps {
  initialFilters?: MatrixFilters | null;
  onInitialFiltersApplied?: () => void;
}

function CollapsibleFilterSection({
  id,
  label,
  children,
  expandedSections,
  onToggle,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
  expandedSections: Set<string>;
  onToggle: (sectionId: string) => void;
}) {
  const open = expandedSections.has(id);
  return (
    <div className="pt-2.5 sm:pt-3 first:pt-0 border-t border-border-subtle/40 first:border-t-0">
      <button
        onClick={() => onToggle(id)}
        className="flex items-center justify-between w-full cursor-pointer group"
      >
        <span className="text-[10px] uppercase tracking-wider text-text-tertiary font-medium group-hover:text-text-primary transition-colors">
          {label}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-text-tertiary group-hover:text-text-primary transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      <div
        style={{
          display: 'grid',
          gridTemplateRows: open ? '1fr' : '0fr',
          transition: 'grid-template-rows 0.25s cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <div className="overflow-hidden">
          <div className="flex flex-wrap gap-1 sm:gap-1.5 pt-1.5">{children}</div>
        </div>
      </div>
    </div>
  );
}

export default function ProductMatrix({
  initialFilters,
  onInitialFiltersApplied,
}: ProductMatrixProps = {}) {
  const { t } = useLanguage();
  const { ds, version } = useDataSourceVersion('products');
  const products = useMemo(() => ds.products.list, [ds, version]);
  const categories = useMemo(() => ds.dictionaries.categories, [ds, version]);
  const suppliers = useMemo(() => ds.dictionaries.suppliers, [ds, version]);
  const colors = useMemo(() => ds.dictionaries.colors, [ds, version]);
  const notifications = ds.notifications;
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedSuppliers, setSelectedSuppliers] = useState<string[]>([]);
  const [selectedColors, setSelectedColors] = useState<string[]>([]);
  const [selectedPower, setSelectedPower] = useState<number[]>([]);
  const [selectedLength, setSelectedLength] = useState<number[]>([]);
  const [selectedMissingFields, setSelectedMissingFields] = useState<string[]>([]);
  const [selectedCabinets, setSelectedCabinets] = useState<MarketplaceEntityCode[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set(['category']));
  function toggleSection(id: string) {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedProduct, setSelectedProduct] = useState<ProductWithRelations | null>(null);
  const [exporting, setExporting] = useState(false);
  const [tableKey, setTableKey] = useState(0);
  const [pageSize, setPageSize] = useState(15);
  const [pageSizeOpen, setPageSizeOpen] = useState(false);
  const pageSizeRef = useRef<HTMLDivElement>(null);
  const pageSizeOptions = [15, 25, 50, 100];
  const handleDetailClose = useCallback(() => setSelectedProduct(null), []);
  const handleRowClick = useCallback((p: ProductWithRelations) => setSelectedProduct(p), []);

  useEffect(() => {
    if (initialFilters) {
      setSelectedCategories(initialFilters.categories ?? []);
      setSelectedSuppliers(initialFilters.suppliers ?? []);
      setSelectedColors(initialFilters.colors ?? []);
      setSelectedPower(initialFilters.power ?? []);
      setSelectedLength(initialFilters.length ?? []);
      setSelectedMissingFields(initialFilters.missingFields ?? []);
      setSelectedCabinets((initialFilters.cabinets ?? []) as MarketplaceEntityCode[]);
      setCurrentPage(1);
      setTableKey((k) => k + 1);
      onInitialFiltersApplied?.();
    }
  }, [initialFilters, onInitialFiltersApplied]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (pageSizeRef.current && !pageSizeRef.current.contains(e.target as Node)) {
        setPageSizeOpen(false);
      }
    }
    if (pageSizeOpen) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [pageSizeOpen]);

  const filteredProducts = useMemo(() => {
    const q = deferredSearchQuery.toLowerCase();
    return products.filter((p) => {
      const matchesSearch =
        !q ||
        p.sku.toLowerCase().includes(q) ||
        p.productName.toLowerCase().includes(q) ||
        (p.model?.name_source?.toLowerCase() || '').includes(q) ||
        (p.model?.name_product?.toLowerCase() || '').includes(q) ||
        (p.color?.name_source?.toLowerCase() || '').includes(q) ||
        (p.color?.name_product?.toLowerCase() || '').includes(q) ||
        getProductMarketplaceSearchText(p).includes(q);

      const matchesCategory =
        selectedCategories.length === 0 || selectedCategories.includes(p.category.code);
      const matchesSupplier =
        selectedSuppliers.length === 0 || selectedSuppliers.includes(p.supplier?.code || '-');
      const matchesColor =
        selectedColors.length === 0 || (p.color && selectedColors.includes(p.color.code));
      const matchesPower =
        selectedPower.length === 0 || (p.powerW != null && selectedPower.includes(p.powerW));
      const matchesLength =
        selectedLength.length === 0 || (p.lengthM != null && selectedLength.includes(p.lengthM));
      const matchesCabinet =
        selectedCabinets.length === 0 ||
        (p.marketplaceSkus || []).some((sku) => selectedCabinets.includes(sku.entity));

      const matchesMissingFields =
        selectedMissingFields.length === 0 ||
        selectedMissingFields.some((field) => {
          // Kit component fields: just the component category code (e.g., "szu", "cable")
          if (p.isKit) {
            const reqFields = categoryRequiredFields[field];
            if (reqFields) {
              return p.kitComponents?.some((comp) => {
                if (comp.product.category.code !== field) return false;
                return reqFields.some((fd) => {
                  const val = comp.product[fd.field as keyof ProductWithRelations];
                  return val == null || val === '';
                });
              }) ?? false;
            }
          }
          const val = p[field as keyof ProductWithRelations];
          return val == null || val === '';
        });

      return (
        matchesSearch &&
        matchesCategory &&
        matchesCabinet &&
        matchesSupplier &&
        matchesColor &&
        matchesPower &&
        matchesLength &&
        matchesMissingFields
      );
    });
  }, [
    products,
    deferredSearchQuery,
    selectedCategories,
    selectedSuppliers,
    selectedColors,
    selectedPower,
    selectedLength,
    selectedMissingFields,
    selectedCabinets,
  ]);

  const paginatedProducts = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredProducts.slice(start, start + pageSize);
  }, [filteredProducts, currentPage, pageSize]);

  const totalPages = Math.ceil(filteredProducts.length / pageSize);

  const toggleCategory = useCallback((code: string) => {
    setSelectedCategories((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
    setCurrentPage(1);
    setTableKey((k) => k + 1);
  }, []);

  const toggleSupplier = useCallback((code: string) => {
    setSelectedSuppliers((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
    setCurrentPage(1);
    setTableKey((k) => k + 1);
  }, []);

  const toggleColor = useCallback((code: string) => {
    setSelectedColors((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
    setCurrentPage(1);
    setTableKey((k) => k + 1);
  }, []);

  const togglePower = useCallback((val: number) => {
    setSelectedPower((prev) =>
      prev.includes(val) ? prev.filter((v) => v !== val) : [...prev, val]
    );
    setCurrentPage(1);
    setTableKey((k) => k + 1);
  }, []);

  const toggleLength = useCallback((val: number) => {
    setSelectedLength((prev) =>
      prev.includes(val) ? prev.filter((v) => v !== val) : [...prev, val]
    );
    setCurrentPage(1);
    setTableKey((k) => k + 1);
  }, []);

  const toggleCabinet = useCallback((code: MarketplaceEntityCode) => {
    setSelectedCabinets((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
    setCurrentPage(1);
    setTableKey((k) => k + 1);
  }, []);

  const uniqueColors = useMemo(() => {
    const codes = new Set(products.map((p) => p.color?.code).filter(Boolean));
    return colors.filter((c) => codes.has(c.code));
  }, [products]);

  const uniquePowerValues = useMemo(() => {
    const vals = new Set(products.map((p) => p.powerW).filter((v): v is number => v != null));
    return [...vals].sort((a, b) => a - b);
  }, [products]);

  const uniqueLengthValues = useMemo(() => {
    const vals = new Set(products.map((p) => p.lengthM).filter((v): v is number => v != null));
    return [...vals].sort((a, b) => a - b);
  }, [products]);

  const uniqueCabinets = useMemo(() => {
    const codes = new Set<MarketplaceEntityCode>();
    for (const p of products) {
      for (const sku of p.marketplaceSkus || []) {
        codes.add(sku.entity);
      }
    }
    return ENTITY_ORDER.filter((code) => codes.has(code));
  }, [products]);

  const activeFiltersCount =
    selectedCategories.length +
    selectedCabinets.length +
    selectedSuppliers.length +
    selectedColors.length +
    selectedPower.length +
    selectedLength.length +
    selectedMissingFields.length;

  const handleExport = useCallback(() => {
    setExporting(true);
    setTimeout(() => {
      const headers = [
        'SKU',
        'Name',
        'Category',
        'Model',
        'Power_W',
        'Length_M',
        'Color',
        'Supplier',
      ];
      const rows = filteredProducts.map((p) => [
        p.sku,
        `"${p.productName.replace(/"/g, '""')}"`,
        displaySource(p.category),
        displaySource(p.model),
        p.powerW || '',
        p.lengthM || '',
        p.color ? displaySource(p.color) : '',
        p.supplier?.name || '',
      ]);

      const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
      const blob = new Blob([new Uint8Array([0xef, 0xbb, 0xbf]), csvContent], {
        type: 'text/csv;charset=utf-8;',
      });
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute(
        'download',
        `gqbox_matrix_export_${new Date().toISOString().slice(0, 10)}.csv`
      );
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setExporting(false);
      notifications.add({ title: t('matrix.notif_exported').replace('{count}', String(filteredProducts.length)), type: 'info' });
    }, 600);
  }, [filteredProducts, notifications, t]);

  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      if (currentPage <= 4) {
        pages.push(1, 2, 3, 4, 5, '...', totalPages);
      } else if (currentPage >= totalPages - 3) {
        pages.push(
          1,
          '...',
          totalPages - 4,
          totalPages - 3,
          totalPages - 2,
          totalPages - 1,
          totalPages
        );
      } else {
        pages.push(1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages);
      }
    }
    return pages;
  };

  const supplierBadge = useCallback((code?: string) => {
    const c = code || '-';
    return (
      <span
        className={`text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5 rounded ${
          c === 'A'
            ? 'bg-supplier-a-bg text-supplier-a'
            : c === 'W'
              ? 'bg-supplier-w-bg text-supplier-w'
              : c === 'AW'
                ? 'bg-supplier-aw-bg text-supplier-aw'
                : 'bg-bg-elevated text-text-muted'
        }`}
      >
        {c === '-' ? '—' : c}
      </span>
    );
  }, []);

  const clearAllFilters = useCallback(() => {
    setSelectedCategories([]);
    setSelectedCabinets([]);
    setSelectedSuppliers([]);
    setSelectedColors([]);
    setSelectedPower([]);
    setSelectedLength([]);
    setSelectedMissingFields([]);
    setShowFilters(false);
  }, []);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setCurrentPage(1);
    setTableKey((k) => k + 1);
  }, []);

  const rowKeyFn = useCallback((p: ProductWithRelations) => p.id, []);
  const rowClassNameFn = useCallback(() => 'table-row-hover cursor-pointer', []);

  const productColumns: Column<ProductWithRelations>[] = useMemo(() => [
    {
      key: 'sku',
      header: t('matrix.col.sku'),
      width: 12,
      nowrap: true,
      cell: (p) => (
        <div className="flex items-center min-w-0" title={p.sku}>
          <code className="text-[11px] sm:text-xs text-accent truncate">{p.sku}</code>

        </div>
      ),
    },
    {
      key: 'product',
      header: t('matrix.col.product'),
      width: 24,
      cell: (p) => {
        const Icon = categoryIcons[p.category.code] || Package;
        return (
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0" title={displayProductName(p)}>
            <Icon
              className="w-3 sm:w-3.5 h-3 sm:h-3.5 flex-shrink-0"
              style={{ color: getCategoryColorVar(p.category) }}
            />
            <span className="truncate text-xs sm:text-sm">{displayProductName(p)}</span>
          </div>
        );
      },
    },
    {
      key: 'cat',
      header: t('matrix.col.cat'),
      width: 10,
      cell: (p) => (
        <span
          className="text-[11px] sm:text-xs truncate block"
          style={{ color: getCategoryColorVar(p.category) }}
          title={displaySource(p.category)}
        >
          {displaySource(p.category)}
        </span>
      ),
    },
    {
      key: 'model',
      header: t('matrix.col.model'),
      width: 14,
      cell: (p) => (
        <span
          className="text-[11px] sm:text-xs text-text-secondary truncate block"
          title={displaySource(p.model)}
        >
          {displaySource(p.model)}
        </span>
      ),
    },
    {
      key: 'power',
      header: t('matrix.col.power'),
      width: 8,
      nowrap: true,
      cell: (p) => (
        <span className="text-[11px] sm:text-xs text-text-secondary truncate block">
          {p.powerW ? `${p.powerW}W` : '—'}
        </span>
      ),
    },
    {
      key: 'length',
      header: t('matrix.col.length'),
      width: 8,
      nowrap: true,
      cell: (p) => (
        <span className="text-[11px] sm:text-xs text-text-secondary truncate block">
          {p.lengthM ? `${p.lengthM}м` : '—'}
        </span>
      ),
    },
    {
      key: 'color',
      header: t('matrix.col.color'),
      width: 12,
      cell: (p) =>
        p.color ? (
          <div
            className="flex items-center gap-1 sm:gap-1.5 min-w-0"
            title={displaySource(p.color)}
          >
            <div
              className="w-2 sm:w-2.5 h-2 sm:h-2.5 rounded-full flex-shrink-0"
              style={{
                background:
                  p.color.color === 'gradient'
                    ? 'conic-gradient(in hsl longer hue, red, red)'
                    : p.color.color,
                border:
                  p.color.color === 'gradient' ? 'none' : '1px solid var(--color-border-subtle)',
              }}
            />
            <span className="truncate text-[11px] sm:text-xs text-text-secondary">
              {displaySource(p.color)}
            </span>
          </div>
        ) : null,
    },
    {
      key: 'sup',
      header: t('matrix.col.sup'),
      width: 8,
      nowrap: true,
      cell: (p) => supplierBadge(p.supplier?.code),
    },
    {
      key: 'view',
      header: '',
      width: 4,
      align: 'right',
      cell: () => (
        <Eye className="w-3 sm:w-3.5 h-3 sm:h-3.5 text-text-muted hover:text-text-primary transition-colors" />
      ),
    },
  ], [t, supplierBadge]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start sm:items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl sm:text-2xl font-semibold text-gradient">{t('matrix.title')}</h2>
          <p className="text-xs sm:text-sm text-text-secondary mt-0.5 sm:mt-1">
            {filteredProducts.length} {t('matrix.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="relative" ref={pageSizeRef}>
            <button
              onClick={() => setPageSizeOpen(!pageSizeOpen)}
              className="flex items-center justify-center gap-1.5 h-11 sm:h-10 px-3 min-w-[88px] rounded-lg border text-xs sm:text-sm transition-[colors,opacity,transform,box-shadow] cursor-pointer bg-bg-secondary border-border-subtle text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            >
              <List className="w-3.5 h-3.5" />
              <span className="tabular-nums">{pageSize}</span>
              <ChevronDown className={`w-3 h-3 transition-transform duration-150 ${pageSizeOpen ? 'rotate-180' : ''}`} />
            </button>
            {pageSizeOpen && (
              <div className="absolute right-0 top-full mt-2 w-full glass rounded-lg border border-border-subtle overflow-hidden z-50">
                {pageSizeOptions.map((opt) => (
                  <button
                    key={opt}
                    onClick={() => {
                      setPageSize(opt);
                      setPageSizeOpen(false);
                      setCurrentPage(1);
                      setTableKey((k) => k + 1);
                    }}
                    className={`w-full text-center px-3 py-2 text-xs transition-colors cursor-pointer ${
                      pageSize === opt
                        ? 'bg-accent/20 text-white'
                        : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={handleExport}
            disabled={exporting || filteredProducts.length === 0}
            className="flex items-center justify-center gap-1.5 sm:gap-2 min-w-[120px] px-3 sm:px-4 h-11 sm:h-10 rounded-lg bg-accent/25 text-white text-xs sm:text-sm hover:bg-accent/35 transition-[colors,opacity,transform,box-shadow] cursor-pointer font-medium border border-accent/40 flex-shrink-0"
          >
            {exporting ? (
              <Check className="w-3.5 h-3.5 text-success" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            {exporting ? t('matrix.exporting') : t('matrix.export')}
          </button>
        </div>
      </div>

      {/* Search & Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1">
          <input
            type="text"
            placeholder={t('matrix.search')}
            value={searchQuery}
            onChange={handleSearchChange}
            className="w-full px-4 text-text-primary transition-[colors,opacity,transform,box-shadow] duration-150 h-11 sm:h-10"
          />
        </div>
        {activeFiltersCount > 0 && (
          <button
            onClick={clearAllFilters}
            className="h-11 sm:h-10 min-w-0 flex items-center gap-1.5 px-3 rounded-lg border text-sm transition-[colors,opacity,transform,box-shadow] duration-150 outline-none ring-0 focus:outline-none focus-visible:outline-none focus-visible:ring-0 cursor-pointer bg-bg-secondary border-border-subtle text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
          >
            <X className="w-3.5 h-3.5" />
            <span>{t('matrix.clear')}</span>
          </button>
        )}
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`h-11 sm:h-10 min-w-[120px] justify-center flex items-center gap-2 px-4 rounded-lg border text-sm transition-[colors,opacity,transform,box-shadow] duration-150 outline-none ring-0 focus:outline-none focus-visible:outline-none focus-visible:ring-0 cursor-pointer ${
            showFilters || activeFiltersCount > 0
              ? 'bg-bg-elevated text-text-primary border border-border-strong'
              : 'bg-bg-secondary border-border-subtle text-text-secondary hover:bg-bg-hover hover:text-text-primary'
          }`}
        >
          <SlidersHorizontal
            className={`w-3.5 h-3.5 transition-transform duration-150 ${showFilters ? 'rotate-180' : ''}`}
          />
          {t('matrix.filters')}
          {activeFiltersCount > 0 && (
            <span className="ml-1 w-5 h-5 rounded-full bg-accent text-white text-[10px] flex items-center justify-center transition-[colors,opacity,transform,box-shadow] duration-150 scale-in">
              {activeFiltersCount}
            </span>
          )}
        </button>
      </div>

      {/* Filter Panel */}
      <div
        style={{
          display: 'grid',
          gridTemplateRows: showFilters ? '1fr' : '0fr',
          transition: 'grid-template-rows 0.25s cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <div className="overflow-hidden">
          <div className="glass rounded-xl px-3 sm:px-4 py-2.5 sm:py-3.5">
            <CollapsibleFilterSection id="category" label={t('matrix.cat')} expandedSections={expandedSections} onToggle={toggleSection}>
              {categories.map((cat) => {
                const active = selectedCategories.includes(cat.code);
                const accent = getCategoryColorVar(cat);
                return (
                  <button
                    key={cat.code}
                    onClick={() => toggleCategory(cat.code)}
                    className={`h-7 sm:h-8 px-2 sm:px-2.5 rounded-lg text-[11px] sm:text-xs font-medium transition-colors cursor-pointer ${
                      active
                        ? 'text-white border border-transparent'
                        : 'bg-bg-tertiary/60 text-text-secondary hover:bg-bg-hover hover:text-text-primary border border-transparent'
                    }`}
                    style={active ? { background: accent } : {}}
                  >
                    {displaySource(cat)}
                  </button>
                );
              })}
            </CollapsibleFilterSection>

            <CollapsibleFilterSection id="cabinet" label={t('matrix.cabinet')} expandedSections={expandedSections} onToggle={toggleSection}>
              {uniqueCabinets.map((code) => {
                const active = selectedCabinets.includes(code);
                return (
                  <button
                    key={code}
                    onClick={() => toggleCabinet(code)}
                    className={`h-7 sm:h-8 px-2 sm:px-2.5 rounded-lg text-[11px] sm:text-xs font-medium transition-colors cursor-pointer ${
                      active
                        ? 'bg-accent/20 text-white border border-accent/40'
                        : 'bg-bg-tertiary/60 text-text-secondary hover:bg-bg-hover hover:text-text-primary border border-transparent'
                    }`}
                  >
                    {ENTITY_LABELS[code]}
                  </button>
                );
              })}
            </CollapsibleFilterSection>

            <CollapsibleFilterSection id="supplier" label={t('matrix.sup')} expandedSections={expandedSections} onToggle={toggleSection}>
              {suppliers.map((sup) => {
                const active = selectedSuppliers.includes(sup.code);
                return (
                  <button
                    key={sup.code}
                    onClick={() => toggleSupplier(sup.code)}
                    className={`h-7 sm:h-8 px-2 sm:px-2.5 rounded-lg text-[11px] sm:text-xs font-medium transition-colors cursor-pointer ${
                      active
                        ? 'bg-accent/20 text-white border border-accent/40'
                        : 'bg-bg-tertiary/60 text-text-secondary hover:bg-bg-hover hover:text-text-primary border border-transparent'
                    }`}
                  >
                    {sup.name}
                  </button>
                );
              })}
            </CollapsibleFilterSection>

            <CollapsibleFilterSection id="power" label={t('matrix.col.power')} expandedSections={expandedSections} onToggle={toggleSection}>
              {uniquePowerValues.map((val) => {
                const active = selectedPower.includes(val);
                return (
                  <button
                    key={val}
                    onClick={() => togglePower(val)}
                    className={`h-7 sm:h-8 px-2 sm:px-2.5 rounded-lg text-[11px] sm:text-xs font-medium tabular-nums transition-colors cursor-pointer ${
                      active
                        ? 'bg-accent/20 text-white border border-accent/40'
                        : 'bg-bg-tertiary/60 text-text-secondary hover:bg-bg-hover hover:text-text-primary border border-transparent'
                    }`}
                  >
                    {val}W
                  </button>
                );
              })}
            </CollapsibleFilterSection>

            <CollapsibleFilterSection id="length" label={t('matrix.col.length')} expandedSections={expandedSections} onToggle={toggleSection}>
              {uniqueLengthValues.map((val) => {
                const active = selectedLength.includes(val);
                return (
                  <button
                    key={val}
                    onClick={() => toggleLength(val)}
                    className={`h-7 sm:h-8 px-2 sm:px-2.5 rounded-lg text-[11px] sm:text-xs font-medium tabular-nums transition-colors cursor-pointer ${
                      active
                        ? 'bg-accent/20 text-white border border-accent/40'
                        : 'bg-bg-tertiary/60 text-text-secondary hover:bg-bg-hover hover:text-text-primary border border-transparent'
                    }`}
                  >
                    {val}м
                  </button>
                );
              })}
            </CollapsibleFilterSection>

            <CollapsibleFilterSection id="color" label={t('matrix.col.color')} expandedSections={expandedSections} onToggle={toggleSection}>
              {uniqueColors.map((c) => {
                const active = selectedColors.includes(c.code);
                return (
                  <button
                    key={c.code}
                    onClick={() => toggleColor(c.code)}
                    title={displaySource(c)}
                    className={`flex items-center gap-1.5 h-7 sm:h-8 px-2 sm:px-2.5 rounded-lg text-[11px] sm:text-xs font-medium transition-colors cursor-pointer ${
                      active
                        ? 'bg-accent/20 text-white border border-accent/40'
                        : 'bg-bg-tertiary/60 text-text-secondary hover:bg-bg-hover hover:text-text-primary border border-transparent'
                    }`}
                  >
                    <span
                      className="inline-block w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full shrink-0"
                      style={{
                        background: c.color === 'gradient' ? 'conic-gradient(in hsl longer hue, red, red)' : c.color || '#888',
                        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
                      }}
                    />
                    <span className="truncate max-w-[80px]">{c.name_source}</span>
                  </button>
                );
              })}
            </CollapsibleFilterSection>
          </div>
        </div>
      </div>

      {/* Data — Table (≥sm) and Cards (<sm) */}
      <div className="glass rounded-xl overflow-hidden">
        {/* Table — desktop/tablet */}
        <div className="hidden sm:block">
          <ResponsiveTable
            columns={productColumns}
            rows={paginatedProducts}
            rowKey={rowKeyFn}
            minWidth={720}
            emptyMessage={t('matrix.empty')}
            bodyClassName="table-fade-in"
            rowClassName={rowClassNameFn}
            onRowClick={handleRowClick}
          />
        </div>

        {/* Cards — mobile */}
        <div key={tableKey} className="sm:hidden p-2 space-y-2 animate-card-in">
          {paginatedProducts.map((product) => {
            const Icon = categoryIcons[product.category.code] || Package;
            return (
              <button
                key={product.id}
                onClick={() => setSelectedProduct(product)}
                aria-label={`${displayProductName(product)} ${product.sku}`}
                className="w-full text-left glass rounded-xl p-3 active:scale-[0.99] transition-transform cursor-pointer"
              >
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Icon
                      className="w-3.5 h-3.5 flex-shrink-0"
                      style={{ color: getCategoryColorVar(product.category) }}
                    />
                    <span
                      className="text-[11px] font-medium truncate"
                      style={{ color: getCategoryColorVar(product.category) }}
                    >
                      {displaySource(product.category)}
                    </span>
                  </div>
                  {supplierBadge(product.supplier?.code)}
                </div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <code className="text-[11px] text-accent truncate">{product.sku}</code>

                </div>
                <p className="text-sm font-medium text-text-primary line-clamp-2 mb-2">
                  {displayProductName(product)}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary border border-border-subtle truncate max-w-[120px]">
                    {displaySource(product.model)}
                  </span>
                  {product.powerW != null && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary border border-border-subtle">
                      {product.powerW}W
                    </span>
                  )}
                  {product.lengthM != null && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary border border-border-subtle">
                      {product.lengthM}м
                    </span>
                  )}
                  {product.color && (
                    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary border border-border-subtle">
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-full border border-border-subtle shrink-0"
                        style={{
                          background:
                            product.color.color === 'gradient'
                              ? 'conic-gradient(in hsl longer hue, red, red)'
                              : product.color.color,
                          border:
                            product.color.color === 'gradient'
                              ? 'none'
                              : '1px solid var(--color-border-subtle)',
                        }}
                      />
                      <span className="truncate max-w-[80px]">
                        {displaySource(product.color)}
                      </span>
                    </span>
                  )}
                </div>
              </button>
            );
          })}
          {paginatedProducts.length === 0 && (
            <div className="py-8 text-center text-xs text-text-tertiary">{t('matrix.empty')}</div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 0 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 sm:gap-3 px-3 sm:px-4 py-2 sm:py-3 border-t border-border-subtle">
            <p className="text-[10px] sm:text-xs text-text-tertiary text-center">
              {t('matrix.showing')} {(currentPage - 1) * pageSize + 1} {t('matrix.to')}{' '}
              {Math.min(currentPage * pageSize, filteredProducts.length)} {t('matrix.of')}{' '}
              {filteredProducts.length}
            </p>
            <div className="flex items-center gap-0.5 sm:gap-1 flex-nowrap justify-center overflow-x-auto scrollbar-hide">
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="h-9 w-9 rounded-lg hover:bg-bg-hover hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed text-text-secondary cursor-pointer flex items-center justify-center"
                aria-label="Previous page"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>

              {getPageNumbers().map((page, index) => {
                if (page === '...') {
                  return (
                    <span
                      key={`ellipsis-${index}`}
                      className="w-9 text-center text-xs text-text-tertiary select-none"
                    >
                      ...
                    </span>
                  );
                }
                return (
                  <button
                    key={`page-${page}`}
                    onClick={() => setCurrentPage(page as number)}
                    className={`h-9 w-9 rounded-lg text-xs transition-colors outline-none ring-0 focus:outline-none focus-visible:outline-none focus-visible:ring-0 cursor-pointer flex items-center justify-center ${
                      currentPage === page
                        ? 'bg-accent/25 text-white border border-accent/40 font-medium'
                        : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                    }`}
                    aria-label={`Page ${page}`}
                  >
                    {page}
                  </button>
                );
              })}

              <button
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="h-9 w-9 rounded-lg hover:bg-bg-hover hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed text-text-secondary cursor-pointer flex items-center justify-center"
                aria-label="Next page"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Product Detail Card */}
      {selectedProduct && (
        <div className="animate-fade-in-fast">
          <ProductDetailCard
            product={selectedProduct}
            onClose={handleDetailClose}
            highlightedFields={selectedMissingFields}
          />
        </div>
      )}
    </div>
  );
}
