import { v } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import { requireAuthedUserId, ensureUserFields, getOrCreateProfile } from "./helpers";

// ─── Constants ──────────────────────────────────────────────────

const CREDITS_TRYON = 10;
const CREDITS_SEARCH = 5;
const FREE_MONTHLY_CREDITS = 30;
const PRO_MONTHLY_CREDITS = 300;

// ─── Queries ────────────────────────────────────────────────────

/** Get current user's credit balance. */
export const getBalance = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuthedUserId(ctx);
    const user = await ensureUserFields(ctx, userId);
    return {
      balance: user.creditBalance,
      plan: user.plan,
    };
  },
});

/** Get credit ledger history. */
export const getLedger = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuthedUserId(ctx);
    return ctx.db
      .query("creditLedger")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
  },
});

// ─── Mutations ──────────────────────────────────────────────────

/**
 * Apply a try-on credit deduction for a specific user.
 *
 * Shared implementation: the public `deductTryon` mutation (called from
 * frontend, authed) and `tryon.startTryon` mutation both use this. The auth
 * check stays at the outer mutation level; this helper does the actual
 * balance update + ledger insert. Throws if insufficient balance.
 */
export async function deductTryonImpl(
  ctx: any,
  userId: string,
  refId?: string
): Promise<{ balance: number }> {
  const user = await ensureUserFields(ctx, userId);

  if (user.creditBalance < CREDITS_TRYON) {
    throw new Error(
      `Insufficient credits. Need ${CREDITS_TRYON}, have ${user.creditBalance}.`
    );
  }

  const newBalance = user.creditBalance - CREDITS_TRYON;
  const profile = await getOrCreateProfile(ctx, userId);
  await ctx.db.patch(profile._id, { creditBalance: newBalance });
  await ctx.db.insert("creditLedger", {
    userId,
    delta: -CREDITS_TRYON,
    reason: "tryon",
    refId,
    balanceAfter: newBalance,
  });

  return { balance: newBalance };
}

/** Deduct credits for try-on. Throws if insufficient balance. */
export const deductTryon = mutation({
  args: { refId: v.optional(v.string()) },
  handler: async (ctx, { refId }) => {
    const userId = await requireAuthedUserId(ctx);
    return deductTryonImpl(ctx, userId, refId);
  },
});

/** Deduct credits for photo search. Throws if insufficient balance. */
export const deductSearch = mutation({
  args: { refId: v.optional(v.string()) },
  handler: async (ctx, { refId }) => {
    const userId = await requireAuthedUserId(ctx);
    const user = await ensureUserFields(ctx, userId);

    if (user.creditBalance < CREDITS_SEARCH) {
      throw new Error(
        `Insufficient credits. Need ${CREDITS_SEARCH}, have ${user.creditBalance}.`
      );
    }

    const newBalance = user.creditBalance - CREDITS_SEARCH;
    const profile = await getOrCreateProfile(ctx, userId);
    await ctx.db.patch(profile._id, { creditBalance: newBalance });
    await ctx.db.insert("creditLedger", {
      userId,
      delta: -CREDITS_SEARCH,
      reason: "search",
      refId,
      balanceAfter: newBalance,
    });

    return { balance: newBalance };
  },
});

/** Refund credits (e.g. failed try-on). */
export const refundCredits = mutation({
  args: {
    amount: v.number(),
    reason: v.optional(v.string()),
    refId: v.optional(v.string()),
  },
  handler: async (ctx, { amount, reason, refId }) => {
    const userId = await requireAuthedUserId(ctx);
    return refundCreditsImpl(ctx, userId, amount, reason, refId);
  },
});

/**
 * Internal: refund credits for a specific user, no auth check.
 *
 * Used by `tryon.processTryon` action when a try-on job fails. Actions
 * invoked via the scheduler don't carry user auth context, so the public
 * `refundCredits` mutation (which calls requireAuthedUserId) would throw.
 * This internal variant takes userId explicitly.
 */
export const refundCreditsInternal = internalMutation({
  args: {
    userId: v.id("users"),
    amount: v.number(),
    reason: v.optional(v.string()),
    refId: v.optional(v.string()),
  },
  handler: async (ctx, { userId, amount, reason, refId }) => {
    return refundCreditsImpl(ctx, userId, amount, reason, refId);
  },
});

/**
 * Shared refund implementation: mutate balance + append ledger entry.
 * No auth check — caller is responsible for authorization.
 */
async function refundCreditsImpl(
  ctx: any,
  userId: string,
  amount: number,
  reason?: string,
  refId?: string
): Promise<{ balance: number }> {
  // Dedup: if a refund for this refId already exists, skip
  if (refId) {
    const existing = await ctx.db
      .query("creditLedger")
      .withIndex("by_user_reason", (q) =>
        q.eq("userId", userId).eq("reason", "refund")
      )
      .filter((entry) => entry.refId === refId)
      .first();
    if (existing) {
      return { balance: (await ensureUserFields(ctx, userId)).creditBalance };
    }
  }

  // Validate amount is positive
  if (amount <= 0) throw new Error("Refund amount must be positive");

  const user = await ensureUserFields(ctx, userId);

  const currentBalance = user.creditBalance;
  const newBalance = currentBalance + amount;
  const profile = await getOrCreateProfile(ctx, userId);
  await ctx.db.patch(profile._id, { creditBalance: newBalance });
  await ctx.db.insert("creditLedger", {
    userId,
    delta: amount,
    reason: (reason || "refund") as any,
    refId,
    balanceAfter: newBalance,
  });

  return { balance: newBalance };
}

/** Grant monthly credits (called by cron or on login). */
export const grantMonthlyCredits = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuthedUserId(ctx);
    const user = await ensureUserFields(ctx, userId);

    const grantAmount =
      user.plan === "pro"
        ? PRO_MONTHLY_CREDITS
        : FREE_MONTHLY_CREDITS;

    // Check if already granted this month (look for recent grant in ledger)
    const now = Date.now();
    const monthStart = new Date(now).toISOString().slice(0, 7); // "YYYY-MM"
    const recentGrants = await ctx.db
      .query("creditLedger")
      .withIndex("by_user_reason", (q) =>
        q.eq("userId", userId).eq("reason", "grant")
      )
      .collect();

    // Simple dedup: if a grant exists from this month, skip
    const alreadyGranted = recentGrants.some((entry) => {
      const entryMonth = new Date(entry._creationTime).toISOString().slice(0, 7);
      return entryMonth === monthStart;
    });

    if (alreadyGranted) return { balance: user.creditBalance, granted: false };

    const newBalance = user.creditBalance + grantAmount;
    const profile = await getOrCreateProfile(ctx, userId);
    await ctx.db.patch(profile._id, { creditBalance: newBalance });
    await ctx.db.insert("creditLedger", {
      userId,
      delta: grantAmount,
      reason: "grant",
      balanceAfter: newBalance,
    });

    return { balance: newBalance, granted: true };
  },
});

// ─── Verify ledger integrity ────────────────────────────────────

/** Verify that sum(credit_ledger.delta) matches user.creditBalance. */
export const verifyLedger = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuthedUserId(ctx);
    const user = await ensureUserFields(ctx, userId);

    const entries = await ctx.db
      .query("creditLedger")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    const computedBalance = entries.reduce((sum, e) => sum + e.delta, 0);
    const cachedBalance = user.creditBalance;

    return {
      computedBalance,
      cachedBalance,
      match: computedBalance === cachedBalance,
      entryCount: entries.length,
    };
  },
});

// ─── Backfill (one-time repair) ──────────────────────────────────

/**
 * Repair the ledger for users created BEFORE `provisionUser` started
 * recording the initial credit grant.
 *
 * Symptom: `verifyLedger` reports `match: false` for any user who never
 * triggered `grantMonthlyCredits` — their `userProfiles.creditBalance`
 * was set directly by provisionUser, but the ledger only recorded
 * subsequent deductions, so `sum(ledger.delta)` is off by exactly
 * FREE_MONTHLY_CREDITS.
 *
 * This mutation finds such users (have a profile but zero "grant" entries)
 * and inserts a backfill grant entry so the ledger is self-consistent.
 * Idempotent — skips users that already have a grant entry. Safe to call
 * repeatedly.
 *
 * Note: `balanceAfter` is set to FREE_MONTHLY_CREDITS, representing the
 * balance immediately after the initial grant at account-creation time.
 * The `_creationTime` of the backfilled row will be "now" rather than the
 * original account-creation time, so `grantMonthlyCredits`'s monthly
 * dedup may suppress this month's monthly grant for repaired users —
 * acceptable for a one-time dev-data repair.
 */
export const backfillInitialGrant = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuthedUserId(ctx);

    // Already has at least one grant entry? Nothing to do.
    const existingGrants = await ctx.db
      .query("creditLedger")
      .withIndex("by_user_reason", (q) =>
        q.eq("userId", userId).eq("reason", "grant")
      )
      .collect();
    if (existingGrants.length > 0) {
      return { repaired: false, reason: "already has grant entry" };
    }

    // No grant entry — backfill one equal to the initial credit grant.
    await ctx.db.insert("creditLedger", {
      userId,
      delta: FREE_MONTHLY_CREDITS,
      reason: "grant",
      balanceAfter: FREE_MONTHLY_CREDITS,
    });

    return { repaired: true, delta: FREE_MONTHLY_CREDITS };
  },
});
