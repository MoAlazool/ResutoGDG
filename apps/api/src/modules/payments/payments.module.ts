import { Global, Module } from '@nestjs/common';
import { CHECKOUT_PORT } from '../kernel/ports';
import { BillsService } from './bills.service';
import { CheckoutService } from './checkout.service';
import { PaymentsJobs } from './payments.jobs';
import { PaymentProvidersService } from './providers.service';
import { PaymentsPublicController, PaymentWebhooksController } from './public.controller';
import { ReceiptsService } from './receipts.service';
import { ReconciliationService } from './reconciliation.service';
import { SandboxProviderService } from './sandbox.service';
import { PaymentsStaffController } from './staff.controller';
import { StaffPaymentsService } from './staff-payments.service';
import { PaymentWebhooksService } from './webhooks.service';

/**
 * ResutoPay. Owner: Agent D1 (docs/architecture/MODULE_CONTRACTS.md).
 * Global so other modules can inject CHECKOUT_PORT (@Optional() @Inject(CHECKOUT_PORT)).
 */
@Global()
@Module({
  controllers: [PaymentsPublicController, PaymentWebhooksController, PaymentsStaffController],
  providers: [
    SandboxProviderService, PaymentProvidersService, PaymentWebhooksService, ReceiptsService, CheckoutService, BillsService,
    StaffPaymentsService, ReconciliationService, PaymentsJobs,
    { provide: CHECKOUT_PORT, useExisting: CheckoutService },
  ],
  exports: [CHECKOUT_PORT, PaymentProvidersService, ReceiptsService],
})
export class PaymentsModule {}
