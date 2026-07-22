import { query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

// ─── Pricing ────────────────────────────────────────────────────
// USD per 1M tokens. Update to match https://platform.openai.com/pricing
// for your account. Longest matching prefix wins, so dated snapshots
// (e.g. gpt-image-2-2026-01-01) resolve to "gpt-image-2".
//
// NOTE: These rates come from klapp101/wardrobe PR #5 (cost_observability).
// VERIFY AGAINST YOUR ACTUAL OPENAI BILL AND ADJUST AS NEEDED.
// Image models bill per-image, not per-token — the `cost` field computed
// below is an ESTIMATE based on token rates and will not match the actual
// per-image charge. Replace with per-image pricing when known.
// Dev test showed: product-match $0.00315, modeled photo $0.24573.
const PRICING: Record<string, { input: number; imageInput?: number; output: number }> = {
  "gpt-image-2": { input: 5, imageInput: 10, output: 40 },
  "gpt-5.4-mini": { input: 0.25, imageInput: 0.25, output: 2 },
};

/**
 * Compute USD cost for a single OpenAI API call.
 * Returns null for unknown models or missing usage — never a fake number.
 *
 * Exported for unit testing and for callers that want to compute cost
 * without going through the DB (e.g. ad-hoc analysis scripts).
 */
export function computeCost(model: string, usage: any): number | null {
  const prefix = Object.keys(PRICING)
    .filter((name) => model.startsWith(name))
    .sort((a, b) => b.length - a.length)[0];
  if (!prefix || !usage) return null;
  const rates = PRICING[prefix];
  const imageTokens = usage.input_tokens_details?.image_tokens || 0;
  const textTokens = Math.max(0, (usage.input_tokens || 0) - imageTokens);
  return (
    textTokens * rates.input +
    imageTokens * (rates.imageInput ?? rates.input) +
    (usage.output_tokens || 0) * rates.output
  ) / 1e6;
}

// ─── Internal: record a single OpenAI API call ──────────────────

/**
 * Insert one usage log row. Called from action handlers after they parse
 * the OpenAI response and see `result.usage`. The caller is responsible
 * for only invoking this when `result.usage` exists (some image endpoints
 * don't return a usage object).
 *
 * Cost is computed inside the mutation (not the action) so that future
 * pricing updates applied here retroactively affect how new rows get
 * priced; existing rows keep the cost they were assigned at write time.
 *
 * Called by `safeRecord` (below) — do not call this directly from actions.
 */
export const record = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    endpoint: v.string(),
    label: v.string(),
    model: v.string(),
    usage: v.any(),  // OpenAI usage object — shape varies by endpoint, we extract fields defensively
    jobId: v.optional(v.string()),
    itemId: v.optional(v.id("wardrobeItems")),
  },
  handler: async (ctx, args) => {
    const u = args.usage;
    const imageTokens = u?.input_tokens_details?.image_tokens || 0;
    const textTokens = Math.max(0, (u?.input_tokens || 0) - imageTokens);
    const cost = computeCost(args.model, u) ?? undefined;
    await ctx.db.insert("usageLogs", {
      ...(args.userId ? { userId: args.userId } : {}),
      at: Date.now(),
      endpoint: args.endpoint,
      label: args.label,
      model: args.model,
      inputTokens: u?.input_tokens || 0,
      textInputTokens: textTokens,
      imageInputTokens: imageTokens,
      outputTokens: u?.output_tokens || 0,
      ...(cost !== undefined ? { cost } : {}),
      ...(args.jobId ? { jobId: args.jobId } : {}),
      ...(args.itemId ? { itemId: args.itemId } : {}),
    });
  },
});

// ─── Admin query: aggregate usage breakdown ─────────────────────

/**
 * Best-effort usage logger for actions.
 *
 * Calls `usage:record` only when `args.usage` is truthy (image endpoints
 * sometimes omit usage). Wrapped in try/catch so a logging failure can
 * never break the user-facing operation that triggered the OpenAI call —
 * a missed cost data point is acceptable; a failed garment generation is
 * not.
 *
 * Import this in any action file that calls OpenAI:
 *   import { safeRecord } from "./usage";
 *   await safeRecord(ctx, { userId, endpoint: "responses", label: "analyze", model, usage: data.usage });
 */
export async function safeRecord(
  ctx: any,
  args: {
    userId?: string;
    endpoint: string;
    label: string;
    model: string;
    usage: any;
    jobId?: string;
    itemId?: string;
  }
): Promise<void> {
  if (!args.usage) return;
  try {
    await ctx.runMutation("usage:record", {
      ...(args.userId ? { userId: args.userId as any } : {}),
      endpoint: args.endpoint,
      label: args.label,
      model: args.model,
      usage: args.usage,
      ...(args.jobId ? { jobId: args.jobId } : {}),
      ...(args.itemId ? { itemId: args.itemId as any } : {}),
    });
  } catch (e) {
    console.error(`[usage] Failed to log ${args.label} (non-fatal):`, e);
  }
}

function parseAdminEmails(): string[] {
  return (process.env.WARDROBE_ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Admin-only: total usage breakdown by model + label, plus the 50 most
 * recent raw records.
 *
 * Gated by the WARDROBE_ADMIN_EMAILS env var (comma-separated list of
 * emails allowed to see aggregate cost data). When unset, no one can
 * call this query — fail closed.
 */
export const getSummary = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized: sign in required");
    const user = await ctx.db.get(userId);
    if (!user?.email) throw new Error("Unauthorized: no email on profile");
    const adminEmails = parseAdminEmails();
    if (adminEmails.length === 0 || !adminEmails.includes(user.email.toLowerCase())) {
      throw new Error("Admin only");
    }

    // Iterate newest-first. Cap at 5000 records to keep the query fast
    // even on long-running deployments; older records still exist in the
    // table but are not reflected in the aggregate totals shown here.
    // Bump this cap if you need fuller history.
    const all = await ctx.db.query("usageLogs").order("desc").take(5000);

    const summarize = (keyOf: (e: any) => string) => {
      const groups: Record<
        string,
        {
          calls: number;
          inputTokens: number;
          outputTokens: number;
          cost: number;
          unpricedCalls: number;
        }
      > = {};
      for (const entry of all) {
        const key = keyOf(entry);
        const bucket = (groups[key] ||= {
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          unpricedCalls: 0,
        });
        bucket.calls += 1;
        bucket.inputTokens += entry.inputTokens;
        bucket.outputTokens += entry.outputTokens;
        if (entry.cost === undefined) bucket.unpricedCalls += 1;
        else bucket.cost += entry.cost;
      }
      return groups;
    };

    return {
      totalCost: all.reduce((sum, e) => sum + (e.cost || 0), 0),
      totalCalls: all.length,
      byModel: summarize((e) => e.model),
      byLabel: summarize((e) => e.label),
      // Raw records are useful for spot-checking — they include userId,
      // jobId, etc. The endpoint is admin-only so this is safe.
      recent: all.slice(0, 50),
    };
  },
});

/**
 * Return the current user's own usage totals (cost + call counts).
 *
 * Used to show users how much they've consumed — useful when free/pro
 * tiers are introduced. Returns null when not signed in.
 */
export const getMyUsage = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const myLogs = await ctx.db
      .query("usageLogs")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(2000);

    const byLabel: Record<string, { calls: number; cost: number }> = {};
    for (const e of myLogs) {
      const bucket = (byLabel[e.label] ||= { calls: 0, cost: 0 });
      bucket.calls += 1;
      bucket.cost += e.cost || 0;
    }

    return {
      totalCost: myLogs.reduce((sum, e) => sum + (e.cost || 0), 0),
      totalCalls: myLogs.length,
      byLabel,
    };
  },
});
