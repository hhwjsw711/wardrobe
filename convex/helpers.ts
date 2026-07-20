import { query, mutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

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

const DEFAULT_PLAN = "free";
const DEFAULT_CREDITS = 30;

/**
 * Return the user with app-level defaults applied.
 *
 * READ-ONLY: safe to call from queries. Does NOT persist defaults.
 * Use the `provisionUser` mutation to persist defaults after sign-up.
 *
 * Why read-only: Convex queries run on read-only context — `ctx.db.patch`
 * is not available there. Mutations that need to read+write the user's
 * balance will patch the user record themselves, which persists any
 * defaults they relied on as a side effect.
 */
export async function ensureUserFields(ctx: any, userId: string) {
  const user = await ctx.db.get(userId);
  if (!user) throw new Error("User not found");
  return {
    ...user,
    plan: user.plan ?? DEFAULT_PLAN,
    creditBalance: user.creditBalance ?? DEFAULT_CREDITS,
  };
}

/**
 * Persist app-level defaults (plan, creditBalance) to the user record
 * if missing. Idempotent — safe to call on every sign-in.
 *
 * Must be called from a MUTATION (queries are read-only). The frontend
 * fires this once when `isAuthenticated` becomes true so that subsequent
 * queries see persisted values instead of in-memory defaults.
 */
export const provisionUser = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const user = await ctx.db.get(userId);
    if (!user) return null;

    const patches: Record<string, any> = {};
    if (user.plan === undefined) patches.plan = DEFAULT_PLAN;
    if (user.creditBalance === undefined) patches.creditBalance = DEFAULT_CREDITS;

    if (Object.keys(patches).length > 0) {
      await ctx.db.patch(userId, patches);
    }

    return { ...user, ...patches };
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
