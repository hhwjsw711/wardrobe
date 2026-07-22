import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireAuthedUserId } from "./helpers";

// ─── Queries ────────────────────────────────────────────────────

/** Get planner entries for a date range. */
export const getPlanner = query({
  args: {
    startDate: v.string(), // "YYYY-MM-DD"
    endDate: v.string(),   // "YYYY-MM-DD"
  },
  handler: async (ctx, { startDate, endDate }) => {
    const userId = await requireAuthedUserId(ctx);
    const entries = await ctx.db
      .query("plannerEntries")
      .withIndex("by_user_date", (q) =>
        q.eq("userId", userId).gte("date", startDate).lte("date", endDate)
      )
      .collect();

    // Enrich with outfit data
    return Promise.all(
      entries.map(async (entry) => {
        if (entry.outfitId) {
          const outfit = await ctx.db.get(entry.outfitId);
          return {
            ...entry,
            outfit: outfit
              ? {
                  ...outfit,
                  imageUrl: outfit.imageStorageId
                    ? await ctx.storage.getUrl(outfit.imageStorageId)
                    : null,
                }
              : null,
          };
        }
        return entry;
      })
    );
  },
});

// ─── Mutations ──────────────────────────────────────────────────

/** Plan an outfit for a specific date. */
export const planOutfit = mutation({
  args: {
    date: v.string(), // "YYYY-MM-DD"
    outfitId: v.optional(v.id("outfits")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { date, outfitId, note }) => {
    const userId = await requireAuthedUserId(ctx);

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("Date must be YYYY-MM-DD format");
    }

    // Validate outfit belongs to user
    if (outfitId) {
      const outfit = await ctx.db.get(outfitId);
      if (!outfit || outfit.userId !== userId) throw new Error("Outfit not found");
    }

    // Upsert: if entry exists for this date, update it
    const existing = await ctx.db
      .query("plannerEntries")
      .withIndex("by_user_date", (q) =>
        q.eq("userId", userId).eq("date", date)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        outfitId: outfitId ?? existing.outfitId,
        note: note ?? existing.note,
      });
      return existing._id;
    }

    return ctx.db.insert("plannerEntries", {
      userId,
      date,
      outfitId,
      note,
    });
  },
});

/** Remove a planner entry. */
export const removePlannerEntry = mutation({
  args: { id: v.id("plannerEntries") },
  handler: async (ctx, { id }) => {
    const userId = await requireAuthedUserId(ctx);
    const entry = await ctx.db.get(id);
    if (!entry || entry.userId !== userId) throw new Error("Not found");
    await ctx.db.delete(id);
  },
});

/** Mark a planner entry as worn (or un-worn). */
export const markWorn = mutation({
  args: {
    id: v.id("plannerEntries"),
    worn: v.boolean(),
  },
  handler: async (ctx, { id, worn }) => {
    const userId = await requireAuthedUserId(ctx);
    const entry = await ctx.db.get(id);
    if (!entry || entry.userId !== userId) throw new Error("Not found");
    await ctx.db.patch(id, { worn });
  },
});
