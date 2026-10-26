export type Severity = "block" | "caution" | "info";

export type Finding = {
  ruleId: string;
  severity: Severity;
  table: string | null;
  summary: string;
  detail: string;
  safeRewrite?: string;
};

export type LiveTableStats = {
  table: string;
  exists: boolean;
  approxRowCount: number;
  totalSizeBytes: number;
  deadTuples: number;
  deadTupleRatio: number;
  lastAutovacuum: string | null;
  lastAutoanalyze: string | null;
  activeBlockingBackends: number;
  pgVersionNum: number;
};

export type Provider = "supabase" | "neon" | "plain-postgres";

export type StatementResult = {
  index: number;
  rawSql: string;
  findings: Finding[];
  stats: LiveTableStats[];
  verdict: Severity;
};

export type MigrationReport = {
  provider: Provider;
  statements: StatementResult[];
  overallVerdict: Severity;
};
