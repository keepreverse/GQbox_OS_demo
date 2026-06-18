export interface Category {
  id: string;
  code: string;
  name_source: string;
  name_product: string;
  color: string;
  icon: string;
  description: string;
  sortOrder: number;
}

export interface Model {
  id: string;
  categoryId: string;
  code: string;
  name_source: string;
  name_product: string;
  description?: string;
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  contactInfo?: string;
}

export interface Color {
  id: string;
  code: string;
  name_source: string;
  name_product: string;
  color: string;
}

export interface Connector {
  id: string;
  code: string;
  name_source: string;
  name_product: string;
}

export interface ChargingProtocol {
  id: string;
  code: string;
  name_source: string;
  name_product: string;
  description?: string;
}

export interface Material {
  id: string;
  code: string;
  name_source: string;
  name_product: string;
}

/**
 * Сырая форма продукта, как она хранится в БД / файлах и
 * как приходит с API. Содержит только id-ссылки на справочники,
 * а не развёрнутые relations. Для UI используется `ProductWithRelations`.
 */
export interface RawProduct {
  id?: string;
  sku: string;
  skuBase?: string;
  categoryId?: string;
  modelId?: string;
  colorId?: string;
  supplierId?: string;
  bodyMaterialId?: string;
  wireMaterialId?: string;
  currentA?: number;
  voltageV?: number;
  powerW?: number;
  lengthM?: number;
  dataTransferMbps?: number;
  deviceCount?: number;
  connectorFemaleId?: string;
  connectorMaleId?: string;
  chargingProtocolId?: string;
  connectionType?: string;
  isKit?: boolean;
  isActive?: boolean;
  variantCode?: string;
  lengthVariant?: string;
  supplierSuffix?: string;
  productName?: string;
  marketplaceSkus?: MarketplaceSku[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ProductBase {
  id: string;
  skuBase: string;
  categoryId: string;
  modelId: string;
  nameTemplate: string;
  nameTemplateRu: string;
  description?: string;
  bodyMaterialId?: string;
  wireMaterialId?: string;
  currentA?: number;
  voltageV?: number;
  powerW?: number;
  lengthM?: number;
  dataTransferMbps?: number;
  deviceCount?: number;
  connectorFemaleId?: string;
  connectorMaleId?: string;
  chargingProtocolId?: string;
  connectionType?: string;
  supplierId?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RawKitComponent {
  kitId: string;
  componentId: string;
  quantity: number;
  sortOrder?: number;
}

export interface KitComponent {
  id: string;
  kitVariantId: string;
  componentVariantId: string;
  quantity: number;
  sortOrder: number;
}

/**
 * Уникальный медиафайл (фото или видео) в хранилище.
 * `url` — относительный путь от бэка (например, `/uploads/<uuid>.jpg`).
 */
export interface MediaFile {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  createdAt: string;
}

/**
 * Связь медиафайла с вариантом товара (M:N).
 */
export interface MediaLink {
  fileId: string;
  variantId: string;
  isPrimary: boolean;
  sortOrder: number;
  uploadedAt: string;
}

/**
 * @deprecated используйте MediaFile + MediaLink.
 * Медиафайл (фото или видео), привязанный к варианту товара.
 */
export interface ProductMedia {
  id: string;
  variantId: string;
  mediaType: 'image' | 'video';
  url: string;
  fileName: string;
  mimeType?: string;
  sizeBytes?: number;
  isPrimary: boolean;
  sortOrder: number;
  uploadedAt: string;
}

export type Marketplace = 'wb' | 'ozon';
export type MarketplaceEntityCode = 'kua' | 'kaa' | 'dev' | 'bms';
export type MarketplaceListingKind = 'single' | 'bundle';

export interface MarketplaceSku {
  marketplace: Marketplace;
  entity: MarketplaceEntityCode;
  article: string;
  kind: MarketplaceListingKind;
  title: string;
}

export interface PackagingItem {
  id: string;
  sku: string;
  name: string;
  name_product: string;
  category: string;
  materialId?: string;
  dimensions?: string;
  colorId?: string;
  supplierId?: string;
}

export interface CategoryAttribute {
  id: string;
  categoryId: string;
  attributeCode: string;
  attributeName: string;
  attributeNameRu: string;
  dataType: 'string' | 'number' | 'boolean' | 'select' | 'multiselect';
  isRequired: boolean;
  options?: string[];
  sortOrder: number;
}

export interface NamingTemplate {
  id: string;
  categoryId: string;
  template: string;
  templateRu: string;
  description?: string;
  isDefault: boolean;
}

export interface ProductWithRelations {
  id: string;
  sku: string;
  skuBase: string;
  category: Category;
  model: Model;
  color?: Color;
  supplier?: Supplier;
  productName: string;
  bodyMaterial?: Material;
  wireMaterial?: Material;
  currentA?: number;
  voltageV?: number;
  powerW?: number;
  lengthM?: number;
  dataTransferMbps?: number;
  deviceCount?: number;
  connectorFemale?: Connector;
  connectorMale?: Connector;
  chargingProtocol?: ChargingProtocol;
  connectionType?: string;
  isKit: boolean;
  isActive: boolean;
  variantCode?: string;
  lengthVariant?: string;
  supplierSuffix?: string;
  createdAt: string;
  description?: string;
  usp?: string;
  tags?: string[];
  media?: ProductMedia[];
  mediaFiles?: MediaFile[];
  mediaLinks?: MediaLink[];
  marketplaceSkus?: MarketplaceSku[];
  kitComponents?: { product: ProductWithRelations; quantity: number }[];
}

export interface SKUPattern {
  prefix: string;
  baseNumber: string;
  variant?: string;
  colorCode?: string;
  supplierSuffix?: string;
  kitSuffix?: string;
}

export interface SystemArchitecture {
  entities: EntityDefinition[];
  relationships: RelationshipDefinition[];
  skuLogic: SKULogicDefinition;
  namingLogic: NamingLogicDefinition;
}

export interface EntityDefinition {
  name: string;
  description: string;
  fields: { name: string; type: string; description: string }[];
}

export interface RelationshipDefinition {
  from: string;
  to: string;
  type: string;
  description: string;
}

export interface SKULogicDefinition {
  pattern: string;
  segments: { code: string; description: string; examples: string[] }[];
  rules: string[];
}

export interface NamingLogicDefinition {
  pattern: string;
  segments: { code: string; description: string; examples: string[] }[];
  rules: string[];
}

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export type UserRole = 'admin' | 'user';

export interface User {
  id: string;
  displayName: string;
  login: string;
  role: UserRole;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AppNotification {
  id: string;
  title: string;
  description?: string;
  createdAt: string;
  unread: boolean;
  type: NotificationType;
  actionView?: ViewType;
}

export interface NotificationsAPI {
  readonly list: AppNotification[];
  readonly unreadCount: number;
  add(n: Omit<AppNotification, 'id' | 'createdAt' | 'unread'>): Promise<void>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
  remove(id: string): Promise<void>;
}

export type ViewType =
  | 'dashboard'
  | 'architecture'
  | 'matrix'
  | 'sku-constructor'
  | 'dictionary'
  | 'product-detail'
  | 'kit-builder'
  | 'media'
  | 'ai-hub'
  | 'db-inspector'
  | 'administration';

export interface MatrixFilters {
  categories?: string[];
  suppliers?: string[];
  colors?: string[];
  power?: number[];
  length?: number[];
  missingFields?: string[];
  cabinets?: string[];
}
