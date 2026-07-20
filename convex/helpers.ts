import { query, mutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// ─── Color helpers ────────────────────────────────────────────────

/**
 * Normalize a color value produced by the OpenAI vision pipeline.
 *
 * The schema allows `secondaryColor` to be a string OR null, and the model
 * usually emits the literal JSON null when there is no secondary color.
 * Occasionally, however, it returns the string "null" (or "none"/""/etc.),
 * which then passes the validator as a string and would otherwise land in
 * the DB verbatim — eventually showing up in the UI palette and triggering
 * `backgroundColor: "null"` console warnings. This helper shrinks those
 * sentinel strings back to real null *before* the value is persisted.
 */
export function sanitizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v || v === "null" || v === "undefined" || v === "none") return null;
  return v;
}

// ─── Auth helpers ────────────────────────────────────────────────

/** Get the authenticated user ID or return null. */
export async function getAuthedUserId(ctx: any): Promise<string | null> {
  return await getAuthUserId(ctx);
}

/** Get the authenticated user ID or throw. */
export async function requireAuthedUserId(ctx: any): Promise<string> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Unauthorized: sign in required");
  return userId;
}

// ─── Image URL helpers ──────────────────────────────────────────

/** Generate a URL for a file stored in Convex File Storage. */
export function getStorageUrl(ctx: any, storageId: string): string {
  return ctx.storage.getUrl(storageId);
}

// ─── User extension helpers ─────────────────────────────────────

const DEFAULT_PLAN = "free" as const;
const DEFAULT_CREDITS = 30;

/**
 * Create a `userProfiles` row with default plan + credits AND record the
 * initial credit grant in the ledger.
 *
 * The ledger entry is critical: without it, `credits:verifyLedger` reports
 * a permanent mismatch for users who never triggered
 * `grantMonthlyCredits`, because their balance was set directly here but
 * the ledger only recorded subsequent deductions.
 *
 * MUST be called from a mutation (writes to db). Idempotent callers must
 * first check for an existing profile via the `by_user` index — this
 * function always inserts.
 */
async function createProfileWithGrant(
  ctx: any,
  userId: string
): Promise<string> {
  const profileId = await ctx.db.insert("userProfiles", {
    userId,
    plan: DEFAULT_PLAN,
    creditBalance: DEFAULT_CREDITS,
  });
  await ctx.db.insert("creditLedger", {
    userId,
    delta: DEFAULT_CREDITS,
    reason: "grant",
    balanceAfter: DEFAULT_CREDITS,
  });
  return profileId;
}

/**
 * Return the user's profile row, creating it with defaults if missing.
 *
 * For use inside MUTATIONS only (writes to db). Queries should use
 * `ensureUserFields` which is read-only.
 */
export async function getOrCreateProfile(ctx: any, userId: string) {
  const existing = await ctx.db
    .query("userProfiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (existing) return existing;

  const id = await createProfileWithGrant(ctx, userId);
  return await ctx.db.get(id);
}

/**
 * Return the user + app-level profile data (plan, creditBalance),
 * with defaults applied when no profile row exists yet.
 *
 * READ-ONLY: safe to call from queries. Does NOT persist defaults.
 * The `provisionUser` mutation persists a profile row after sign-up.
 *
 * Why a separate table: Convex Auth's `users` table has a strict
 * validator that rejects app fields like plan/creditBalance. We keep
 * those in a 1:1 `userProfiles` table instead.
 */
export async function ensureUserFields(ctx: any, userId: string) {
  const user = await ctx.db.get(userId);
  if (!user) throw new Error("User not found");

  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();

  return {
    ...user,
    plan: profile?.plan ?? DEFAULT_PLAN,
    creditBalance: profile?.creditBalance ?? DEFAULT_CREDITS,
    _profileId: profile?._id ?? null,
  };
}

/**
 * Ensure a `userProfiles` row exists for the authenticated user.
 * Idempotent — safe to call on every sign-in. Creates the row with
 * defaults if missing; does NOT overwrite existing values.
 *
 * Must be called from a MUTATION (queries are read-only). The frontend
 * fires this once when `isAuthenticated` becomes true.
 */
export const provisionUser = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const existing = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

    if (existing) return existing;

    return await createProfileWithGrant(ctx, userId);
  },
});

// ─── Current user query (for frontend) ──────────────────────────

export const currentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ensureUserFields(ctx, userId);
    return user;
  },
});
