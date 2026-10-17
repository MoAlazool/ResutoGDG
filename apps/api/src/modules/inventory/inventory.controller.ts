import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import {
  idempotencyKey, inventoryItemInput, inventoryItemUpdate, movementListQuery, recipeInput, stockMovementInput, stocktakeInput,
  supplierInput, supplierUpdate, uuid, wasteReportQuery,
} from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { AllowMcp, RequirePermission, Tenant } from '../../common/auth/decorators';
import { DbService } from '../../common/db/db.service';
import { zod } from '../../common/http/zod.pipe';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { InventoryService } from './inventory.service';

const optionalBranch = z.object({ branchId: uuid.optional() });
const itemListQuery = z.object({ includeArchived: z.enum(['true', 'false']).optional(), q: z.string().max(120).optional() });

@Controller('o/:orgId/inventory')
export class InventoryController {
  constructor(private readonly db: DbService, private readonly inventory: InventoryService, private readonly idem: IdempotencyService) {}

  // Suppliers ---------------------------------------------------------------
  @Get('suppliers')
  @RequirePermission('inventory:read')
  suppliers(@Tenant() ctx: TenantContext) {
    return this.db.scoped(ctx, (tx) => this.inventory.listSuppliers(tx, ctx));
  }

  @Post('suppliers')
  @RequirePermission('inventory:write')
  createSupplier(@Tenant() ctx: TenantContext, @Body(zod(supplierInput)) body: z.infer<typeof supplierInput>) {
    return this.db.scoped(ctx, (tx) => this.inventory.createSupplier(tx, ctx, body));
  }

  @Patch('suppliers/:id')
  @RequirePermission('inventory:write')
  updateSupplier(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(supplierUpdate)) body: z.infer<typeof supplierUpdate>) {
    return this.db.scoped(ctx, (tx) => this.inventory.updateSupplier(tx, ctx, id, body));
  }

  // Items -------------------------------------------------------------------
  @Get('items')
  @RequirePermission('inventory:read')
  @AllowMcp()
  items(@Tenant() ctx: TenantContext, @Query(zod(itemListQuery)) q: z.infer<typeof itemListQuery>) {
    return this.db.scoped(ctx, (tx) => this.inventory.listItems(tx, ctx, { includeArchived: q.includeArchived === 'true', q: q.q }));
  }

  @Post('items')
  @RequirePermission('inventory:write')
  createItem(@Tenant() ctx: TenantContext, @Body(zod(inventoryItemInput)) body: z.infer<typeof inventoryItemInput>) {
    return this.db.scoped(ctx, (tx) => this.inventory.createItem(tx, ctx, body));
  }

  @Patch('items/:id')
  @RequirePermission('inventory:write')
  updateItem(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(inventoryItemUpdate)) body: z.infer<typeof inventoryItemUpdate>) {
    return this.db.scoped(ctx, (tx) => this.inventory.updateItem(tx, ctx, id, body));
  }

  // Levels, valuation, alerts --------------------------------------------------
  @Get('levels')
  @RequirePermission('inventory:read')
  @AllowMcp()
  levels(@Tenant() ctx: TenantContext, @Query(zod(optionalBranch)) q: z.infer<typeof optionalBranch>) {
    return this.db.scoped(ctx, (tx) => this.inventory.levels(tx, ctx, q.branchId));
  }

  @Get('valuation')
  @RequirePermission('inventory:read')
  @AllowMcp()
  valuation(@Tenant() ctx: TenantContext, @Query(zod(optionalBranch)) q: z.infer<typeof optionalBranch>) {
    return this.db.scoped(ctx, (tx) => this.inventory.valuation(tx, ctx, q.branchId));
  }

  @Get('alerts')
  @RequirePermission('inventory:read')
  @AllowMcp()
  alerts(@Tenant() ctx: TenantContext, @Query(zod(optionalBranch)) q: z.infer<typeof optionalBranch>) {
    return this.db.scoped(ctx, (tx) => this.inventory.openAlerts(tx, ctx, q.branchId));
  }

  @Get('waste-report')
  @RequirePermission('inventory:read')
  @AllowMcp()
  waste(@Tenant() ctx: TenantContext, @Query(zod(wasteReportQuery)) q: z.infer<typeof wasteReportQuery>) {
    return this.db.scoped(ctx, (tx) => this.inventory.wasteReport(tx, ctx, q));
  }

  // Movements -------------------------------------------------------------------
  @Get('movements')
  @RequirePermission('inventory:read')
  movements(@Tenant() ctx: TenantContext, @Query(zod(movementListQuery)) q: z.infer<typeof movementListQuery>) {
    return this.db.scoped(ctx, (tx) => this.inventory.listMovements(tx, ctx, q));
  }

  /** Purchase, waste, adjustment, transfer (paired legs, one transaction) or count. Retry-safe with Idempotency-Key. */
  @Post('movements')
  @RequirePermission('inventory:write')
  record(@Tenant() ctx: TenantContext, @Body(zod(stockMovementInput)) body: z.infer<typeof stockMovementInput>,
    @Headers('idempotency-key') key?: string) {
    return this.db.scoped(ctx, (tx) => key
      ? this.idem.run(tx, ctx.orgId, 'inventory.movement', idempotencyKey.parse(key), body, () => this.inventory.recordMovement(tx, ctx, body))
      : this.inventory.recordMovement(tx, ctx, body));
  }

  @Post('stocktakes')
  @RequirePermission('inventory:write')
  stocktake(@Tenant() ctx: TenantContext, @Body(zod(stocktakeInput)) body: z.infer<typeof stocktakeInput>, @Headers('idempotency-key') key?: string) {
    return this.db.scoped(ctx, (tx) => key
      ? this.idem.run(tx, ctx.orgId, 'inventory.stocktake', idempotencyKey.parse(key), body, () => this.inventory.stocktake(tx, ctx, body))
      : this.inventory.stocktake(tx, ctx, body));
  }

  // Recipes -------------------------------------------------------------------
  @Get('recipes')
  @RequirePermission('inventory:read')
  recipes(@Tenant() ctx: TenantContext) {
    return this.db.scoped(ctx, (tx) => this.inventory.listRecipes(tx, ctx));
  }

  @Get('recipes/:productId')
  @RequirePermission('inventory:read')
  recipe(@Tenant() ctx: TenantContext, @Param('productId', ParseUUIDPipe) productId: string) {
    return this.db.scoped(ctx, (tx) => this.inventory.getRecipe(tx, ctx, productId));
  }

  @Put('recipes/:productId')
  @RequirePermission('inventory:write')
  setRecipe(@Tenant() ctx: TenantContext, @Param('productId', ParseUUIDPipe) productId: string, @Body(zod(recipeInput)) body: z.infer<typeof recipeInput>) {
    return this.db.scoped(ctx, (tx) => this.inventory.setRecipe(tx, ctx, productId, body));
  }
}
