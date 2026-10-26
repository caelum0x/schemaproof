import type { Finding, LiveTableStats } from "./types.js";

/**
 * Optional AI explanation layer. Fully env-gated (same pattern as this
 * portfolio's Bidstage Relay integration): if ANTHROPIC_API_KEY is unset,
 * callers get `null` back immediately and fall back to the rule-engine's
 * own plain-English `detail` + `liveReasoning` text, which is already real
 * (filled with this run's actual numbers, not canned copy) -- the CLI is
 * fully useful with zero API key, matching the OSS self-host-first model.
 */
export async function explainWithAi(
  rawSql: string,
  findings: Finding[],
  stats: LiveTableStats[],
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || findings.length === 0) return null;

  let Anthropic: any;
  try {
    Anthropic = (await import("@anthropic-ai/sdk")).default;
  } catch {
    return null;
  }

  const client = new Anthropic({ apiKey });

  const statsSummary = stats
    .map(
      (s) =>
        `${s.table}: exists=${s.exists}, approx_rows=${s.approxRowCount}, ` +
        `size_mb=${(s.totalSizeBytes / (1024 * 1024)).toFixed(1)}, ` +
        `dead_tuple_ratio=${s.deadTupleRatio.toFixed(2)}, ` +
        `active_blocking_backends=${s.activeBlockingBackends}, ` +
        `last_autovacuum=${s.lastAutovacuum ?? "never"}`,
    )
    .join("\n");

  const findingsSummary = findings
    .map((f) => `[${f.severity.toUpperCase()}] ${f.ruleId}: ${f.summary} -- ${f.detail}`)
    .join("\n");

  const prompt =
    `You are reviewing one real PostgreSQL migration statement against one real database. ` +
    `Below are rule-engine findings (already computed, do not contradict them) and the ` +
    `live catalog stats pulled from this exact database right now.\n\n` +
    `SQL statement:\n${rawSql}\n\n` +
    `Rule-engine findings:\n${findingsSummary}\n\n` +
    `Live stats for the referenced table(s):\n${statsSummary}\n\n` +
    `Write 3-5 sentences of plain-English explanation of why this statement is risky for ` +
    `THIS table given THESE specific numbers (cite the actual row count / active backends ` +
    `/ dead tuple ratio, don't speak generically), then give one concrete safe rewrite as a ` +
    `fenced sql code block. Be specific and concise, no filler.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 700,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b: any) => b.type === "text");
  return textBlock?.text ?? null;
}
