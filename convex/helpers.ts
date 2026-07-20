import { query } from "./_generated/server";
import { auth } from "./auth";

// ─── Auth helpers ────────────────────────────────────────────────

/** Get the authenticated user ID or return null. */
export async function getAuthedUserId(ctx: any): Promise<string | null> {
  const userId = await ctx.auth.getUserId();
  return userId;
}

/** Get the authenticated user ID or throw. */
export async function requireAuthedUserId(ctx: any): Promise<string> {
  const userId = await ctx.auth.getUserId();
  if (!userId) throw new Error("Unauthorized: sign in required");
  return userId;
}

// ─── Image URL helpers ──────────────────────────────────────────

/** Generate a URL for a file stored in Convex File Storage. */
export function getStorageUrl(ctx: any, storageId: string): string {
  return ctx.storage.getUrl(storageId);
}

// ─── User extension helpers ─────────────────────────────────────

/** Ensure user has app-level fields (plan, creditBalance) set. */
export async function ensureUserFields(ctx: any, userId: string) {
  const user = await ctx.db.get(userId);
  if (!user) throw new Error("User not found");
  // Patch defaults if missing
  const patches: Record<string, any> = {};
  if (user.plan === undefined) patches.plan = "free";
  if (user.creditBalance === undefined) patches.creditBalance = 30;
  if (Object.keys(patches).length > 0) {
    await ctx.db.patch(userId, patches);
  }
  return { ...user, ...patches };
}

// ─── Current user query (for frontend) ──────────────────────────

export const currentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await ctx.auth.getUserId();
    if (!userId) return null;
    const user = await ensureUserFields(ctx, userId);
    return user;
  },
});
