// Registration point for business modules (one per directory). Owners fill in
// their module; the lead adds new entries. Keep sorted.
import type { Type } from '@nestjs/common';
import { AdminModule } from './admin/admin.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { BillingModule } from './billing/billing.module';
import { ComplianceModule } from './compliance/compliance.module';
import { ConnectModule } from './connect/connect.module';
import { CustomersModule } from './customers/customers.module';
import { DeliveryModule } from './delivery/delivery.module';
import { ServiceAreaModule } from './delivery/service-area.module';
import { FinanceModule } from './finance/finance.module';
import { FloorModule } from './floor/floor.module';
import { GuestModule } from './guest/guest.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { IntelligenceModule } from './intelligence/intelligence.module';
import { InventoryModule } from './inventory/inventory.module';
import { KitchenModule } from './kitchen/kitchen.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { MarketingModule } from './marketing/marketing.module';
import { McpModule } from './mcp/mcp.module';
import { MenuModule } from './menu/menu.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { ReservationsModule } from './reservations/reservations.module';
import { SearchModule } from './search/search.module';
import { StudioModule } from './studio/studio.module';

export const DOMAIN_MODULES: Type[] = [
  AdminModule,
  AnalyticsModule,
  BillingModule,
  ComplianceModule,
  ConnectModule,
  CustomersModule,
  DeliveryModule,
  ServiceAreaModule,
  FinanceModule,
  FloorModule,
  GuestModule,
  IntegrationsModule,
  IntelligenceModule,
  InventoryModule,
  KitchenModule,
  LoyaltyModule,
  MarketingModule,
  McpModule,
  MenuModule,
  NotificationsModule,
  OrdersModule,
  PaymentsModule,
  ReservationsModule,
  SearchModule,
  StudioModule,
];
