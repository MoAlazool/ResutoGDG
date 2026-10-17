import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { ResearchModel } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { BASELINE_REGISTRY, REGISTRY_NOTICE } from './registry/baselines.generated';

/**
 * Registers the platform baseline models (org_id null) and their offline evaluations from the
 * committed research runs (research/<track>/results/<run-id>/metrics.json, exported by
 * research/export_registry.py). Every one of these evaluations was computed on SYNTHETIC data
 * and is stored with is_synthetic_data = true. Idempotent upsert on start-up.
 */
@Injectable()
export class ModelRegistryService implements OnApplicationBootstrap {
  private readonly logger = new Logger('ModelRegistry');

  constructor(private readonly db: DbService) {}

  async onApplicationBootstrap() {
    try {
      await this.sync();
    } catch (error) {
      this.logger.warn(`model registry sync skipped: ${(error as Error).message}`);
    }
  }

  async sync(): Promise<number> {
    return this.db.withPlatform(async (tx) => {
      let n = 0;
      for (const m of BASELINE_REGISTRY) {
        const row = await tx.one<{ id: string }>(
          `insert into ai_models(org_id, task, name, version, algorithm, params, dataset, is_synthetic_data, status)
           values (null, $1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (task, name, version) where org_id is null do update
             set algorithm = excluded.algorithm, params = excluded.params, dataset = excluded.dataset,
                 is_synthetic_data = excluded.is_synthetic_data, status = excluded.status
           returning id`,
          [m.task, m.name, m.version, m.algorithm, m.params, m.dataset, m.isSyntheticData, m.status]);
        for (const e of m.evaluations) {
          await tx.query(
            `insert into ai_evaluations(model_id, org_id, run_id, split, metrics, baseline_metrics, is_synthetic_data, notes)
             values ($1, null, $2, $3, $4, $5, $6, $7)
             on conflict (model_id, run_id, split) do update set metrics = excluded.metrics, baseline_metrics = excluded.baseline_metrics,
               is_synthetic_data = excluded.is_synthetic_data, notes = excluded.notes`,
            [row.id, e.runId, e.split, e.metrics, e.baselineMetrics, e.isSyntheticData, e.notes]);
        }
        n++;
      }
      return n;
    }, 'intelligence.registry');
  }

  async research(ctx: TenantContext): Promise<{ notice: string; models: ResearchModel[] }> {
    return this.db.scoped(ctx, async (tx) => {
      const models = await tx.query<any>(
        `select id, task, name, version, algorithm, params, dataset, is_synthetic_data from ai_models
          where org_id is null order by task, name, version`);
      const evals = await tx.query<any>(
        `select e.model_id, e.run_id, e.split, e.metrics, e.baseline_metrics, e.is_synthetic_data, e.notes, e.created_at
           from ai_evaluations e join ai_models m on m.id = e.model_id where m.org_id is null order by e.created_at desc`);
      return {
        notice: REGISTRY_NOTICE,
        models: models.map((m) => ({
          id: m.id, task: m.task, name: m.name, version: m.version, algorithm: m.algorithm, params: m.params, dataset: m.dataset,
          isSyntheticData: m.is_synthetic_data,
          evaluations: evals.filter((e) => e.model_id === m.id).map((e) => ({
            runId: e.run_id, split: e.split, metrics: e.metrics, baselineMetrics: e.baseline_metrics, isSyntheticData: e.is_synthetic_data,
            notes: e.notes, createdAt: new Date(e.created_at).toISOString(),
          })),
        })),
      };
    });
  }
}
