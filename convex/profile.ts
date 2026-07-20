import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireAuthedUserId, ensureUserFields } from "./helpers";

// ─── Queries ────────────────────────────────────────────────────

/** Get current user's profile. */
export const getProfile = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuthedUserId(ctx);
    const user = await ensureUserFields(ctx, userId);

    // Derive style profile from wardrobe items
    const items = await ctx.db
      .query("wardrobeItems")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    // Aggregate style insights
    const partCounts: Record<string, number> = {};
    const colorCounts: Record<string, number> = {};
    const allTags: Record<string, number> = {};

    for (const item of items) {
      partCounts[item.part] = (partCounts[item.part] || 0) + 1;
      colorCounts[item.color] = (colorCounts[item.color] || 0) + 1;
      for (const tag of item.tags) {
        allTags[tag] = (allTags[tag] || 0) + 1;
      }
    }

    const topColors = Object.entries(colorCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([color, count]) => ({ color, count }));

    const topTags = Object.entries(allTags)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count }));

    return {
      userId,
      email: user.email,
      name: user.name,
      plan: user.plan,
      creditBalance: user.creditBalance,
      wardrobeCount: items.length,
      partDistribution: partCounts,
      topColors,
      topTags,
    };
  },
});

/** Get available style suggestions based on wardrobe. */
export const getStyles = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuthedUserId(ctx);
    const items = await ctx.db
      .query("wardrobeItems")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    // Extract unique tags and parts
    const tagSet = new Set<string>();
    const parts = new Set<string>();
    for (const item of items) {
      parts.add(item.part);
      for (const tag of item.tags) tagSet.add(tag);
    }

    return {
      availableParts: [...parts],
      availableTags: [...tagSet],
      totalItems: items.length,
    };
  },
});

// ─── Mutations ──────────────────────────────────────────────────

/** Update user's display name. */
export const updateProfile = mutation({
  args: {
    name: v.optional(v.string()),
  },
  handler: async (ctx, { name }) => {
    const userId = await requireAuthedUserId(ctx);
    const patches: Record<string, any> = {};
    if (name) patches.name = name.slice(0, 120);
    if (Object.keys(patches).length > 0) {
      await ctx.db.patch(userId, patches);
    }
  },
});
