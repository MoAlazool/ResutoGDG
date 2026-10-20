import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import {
  salesInquiryInput, salesInquiryListQuery,
  type SalesInquiryInput, type SalesInquiryListQuery, type SalesInquiryReceipt,
} from '@resuto/contracts';
import type { ResutoRequest } from '../../common/auth/context';
import { PlatformAdmin, Public } from '../../common/auth/decorators';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { SalesInquiriesService } from './sales-inquiries.service';

const ip = (req: ResutoRequest) => req.ip ?? 'unknown';

/** `POST /v1/public/sales-inquiries`: the /pricing sales form (audit VP-09). No account needed; rate limited per IP. */
@Controller('public')
export class SalesInquiriesPublicController {
  constructor(private readonly inquiries: SalesInquiriesService, private readonly limiter: RateLimiter) {}

  @Public()
  @Post('sales-inquiries')
  submit(@Req() req: ResutoRequest, @Body(zod(salesInquiryInput)) body: SalesInquiryInput): Promise<SalesInquiryReceipt> {
    this.limiter.hit(`sales-inquiry:${ip(req)}`, 5, 10 * 60_000);
    this.limiter.hit(`sales-inquiry-day:${ip(req)}`, 20, 24 * 60 * 60_000);
    return this.inquiries.submit(body);
  }
}

/** `GET /v1/admin/sales-inquiries`: platform staff read the inbox (support and finance included, read only). */
@Controller('admin/sales-inquiries')
export class SalesInquiriesAdminController {
  constructor(private readonly inquiries: SalesInquiriesService) {}

  @Get()
  @PlatformAdmin()
  list(@Query(zod(salesInquiryListQuery)) q: SalesInquiryListQuery) {
    return this.inquiries.list(q);
  }
}
