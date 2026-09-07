import { z } from "zod";

/** Thresholds a caller may tighten on a single request. */
const Band = z.object({ soft: z.number().positive(), hard: z.number().positive() }).partial();

export const ThresholdOverridesSchema = z
  .object({
    positionSize: Band,
    totalExposure: Band,
    concentration: Band,
    clusterConcentration: Band,
    liquidation: z.object({ minDistance: z.number().positive() }).partial(),
    activityRate: z
      .object({ warn: z.number().int().positive(), ceiling: z.number().int().positive(), windowMs: z.number().int().positive() })
      .partial(),
    staleness: z.object({ maxAccountAgeMs: z.number().int().positive() }).partial(),
    maintenanceMarginRate: z.number().positive(),
  })
  .partial();

export const ProposedActionSchema = z.object({
  /** Exchange symbol, e.g. "BTCUSDT". */
  symbol: z.string().min(3).max(30).transform((s) => s.toUpperCase()),
  side: z.enum(["BUY", "SELL"]),
  quantity: z.number().positive().finite(),
  orderType: z.enum(["MARKET", "LIMIT", "STOP", "STOP_MARKET", "TAKE_PROFIT", "TAKE_PROFIT_MARKET"]),
  /** Absent for spot. */
  leverage: z.number().positive().max(125).optional(),
});

export const CheckRequestSchema = z.object({
  action: ProposedActionSchema,
  /** Per-request overrides; anything omitted falls back to DEFAULT_THRESHOLDS. */
  thresholds: ThresholdOverridesSchema.optional(),
  /** Opaque caller identity, used only to bucket the activity-rate counter. */
  actor: z.string().max(64).optional(),
});

export const ViolationSchema = z.object({
  /** Stable machine-readable rule id, e.g. "position_size". */
  rule: z.string(),
  severity: z.enum(["warn", "reduce", "block"]),
  /** The measured value that was compared against `threshold`. */
  actual: z.number(),
  threshold: z.number(),
  explanation: z.string(),
});

export const AccountSnapshotSchema = z.object({
  equity: z.number(),
  totalNotional: z.number(),
  positionCount: z.number().int().nonnegative(),
  timestamp: z.string(),
});

export const VerdictResponseSchema = z.object({
  verdict: z.enum(["ALLOW", "ALLOW_REDUCED", "BLOCK"]),
  /** Populated only when verdict is ALLOW_REDUCED. */
  suggestedQuantity: z.number().positive().nullable(),
  violations: z.array(ViolationSchema),
  accountSnapshot: AccountSnapshotSchema,
  /** Model output. Explanatory only — never consulted to reach the verdict. */
  narration: z.string().nullable(),
});

/**
 * The response is validated on the way out, not just on the way in.
 *
 * A guardrail that emits a malformed verdict is worse than one that errors:
 * the caller is a program, and a missing `verdict` field reads as falsy rather
 * than as a failure. Validating the egress makes that impossible.
 */
export function assertValidResponse(response) {
  const parsed = VerdictResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error(`guardrail produced an invalid response: ${parsed.error.message}`);
  }
  return parsed.data;
}
