// @resuto/ui — Resuto design-system React components (docs/ui/DESIGN_SYSTEM.md).
// base: PageHeader, Card, Stat, Badge, Notice, EmptyState (+icon), Skeleton, Field, SelectField,
//       TextareaField, DataTable, Modal, Tabs, useAction (stable since the shell commit)
// overlays: Drawer, ConfirmDialog, useConfirm · toast: ToastProvider, useToast
// inputs: SearchInput, Pagination, DateRangePicker, lastDays
// display: Money, formatMinor, useMoneyFormat, useNumberFormat, StatusBadge (+ maps), Timeline,
//          KeyValueList, useReducedMotion, VisuallyHidden
// states: SkeletonBlock/Stats/Table/Cards, Freshness, ErrorState, StaleNotice, Loadable, failureKind, useOnline
// primitives: PageHeading, PageEyebrowProvider, Breadcrumb, StatsStrip(+Skeleton), Panel, PanelHead
// shell: Wordmark, NAV_GLYPHS/NavGlyph, NavBadge, RestaurantChip, Topbar, LiveStatus, WorkspaceFooter, ProfileButton,
//        RouteProgress, initialOf
// display (bidi): UserText, Ltr, Phone, Email, Code · order-ref: OrderRef · figure: figureOf (KPI values that never wrap)
// 2.1 design system (21-DS):
// icon: Icon, DIRECTIONAL_ICONS · nav-icons: NAV_ICONS, NavIcon · provider-logo: ProviderLogo, PROVIDER_LOGOS
// sheet: Sheet, useModalDialog · popover: Popover, Menu, Tooltip
// controls: SegmentedControl, Switch, Combobox, MoneyInput, PhoneInput, Kbd · data-table: DataTableV2, useCursorPagination
// filter-bar: FilterBar, useSavedViews · stat: StatV2, ProvenanceBadge · locked-feature: LockedFeature
// templates: ListPage, DetailPage, WorkspacePage, BoardPage, SettingsPage
// charts: LineChart, AreaChart, BarChart, BarList, DonutChart, FunnelChart, Heatmap, Sparkline, ForecastChart, RouteMap, legends
// motion: withViewTransition, prefersReducedMotion, staggerStyle (CSS classes in ds.css)
export * from './base';
export * from './primitives';
export * from './shell';
export * from './overlays';
export * from './toast';
export * from './inputs';
export * from './display';
export * from './order-ref';
export { figureOf, plainText, type Figure } from './figure';
export * from './states';
export * from './locale';
export { UiStyles } from './styles';
export * from './icon';
export * from './nav-icons';
export * from './provider-logo';
export * from './sheet';
export * from './popover';
export * from './controls';
export * from './data-table';
export * from './filter-bar';
export * from './stat';
export * from './locked-feature';
export * from './templates';
export * from './charts';
export * from './motion';
