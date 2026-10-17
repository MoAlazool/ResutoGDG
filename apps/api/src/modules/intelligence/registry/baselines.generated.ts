export interface RegistryEvaluation { runId: string; split: 'validation' | 'test' | 'backtest'; metrics: any; baselineMetrics: any; isSyntheticData: boolean; notes: string | null }
export interface RegistryModel { task: string; name: string; version: string; algorithm: string; params: any; dataset: any; isSyntheticData: boolean; status: string; evaluations: RegistryEvaluation[] }
export const REGISTRY_NOTICE = 'SYNTHETIC (stub)';
export const BASELINE_REGISTRY: RegistryModel[] = [];
