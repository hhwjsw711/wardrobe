import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
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

/** Deduct credits for try-on. Throws if insufficient balance. */
export const deductTryon = mutation({
  args: { refId: v.optional(v.string()) },
  handler: async (ctx, { refId }) => {
    const userId = await requireAuthedUserId(ctx);
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
  },
});

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
