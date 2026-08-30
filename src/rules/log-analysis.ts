// Extension point for log-derived cache analysis.
// When implemented, this module will parse job logs to extract real cache hit/miss
// rates, enabling rules like "cache-never-hits" and "cache-always-misses".
// The API surface: given a job log stream, return { cacheHits, cacheMisses, cacheSize }
// per cache key, then feed those stats into rules that compare configured vs actual cache behavior.

export interface CacheStats {
  key: string;
  hits: number;
  misses: number;
  sizeBytes?: number;
}

export interface LogAnalysisResult {
  cacheStats: CacheStats[];
}

export function analyzeJobLog(_log: string): LogAnalysisResult {
  return { cacheStats: [] };
}
