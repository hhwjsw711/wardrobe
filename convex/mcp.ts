import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";
import { api } from "./_generated/api";

// ─── MCP Tool Definitions ────────────────────────────────────────
// 14 tools across 6 categories, matching Aesty's MCP surface area.
// Free tools: wardrobe CRUD, outfits, planner, style profile.
// Paid tools: try-on (free experimental), find_items (5 credits).

export const MCP_TOOLS = [
  // ─── Wardrobe (4 tools, all free) ──────────────────────
  {
    name: "get_wardrobe",
    description:
      "Get all items in the user's wardrobe. Returns name, part, color, tags, and product match info for each item.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_wardrobe_item",
    description: "Get details of a specific wardrobe item by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Wardrobe item ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "add_wardrobe_item",
    description:
      "Add an item to the wardrobe. Provide name, part, color, and optionally tags. Images must be uploaded separately via the web app.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Item name (max 120 chars)" },
        part: {
          type: "string",
          enum: [
            "upperbody",
            "lowerbody",
            "wholebody_up",
            "accessories_up",
            "shoes",
          ],
          description: "Body part category",
        },
        color: {
          type: "string",
          description: "Primary color hex (e.g. #1a2b3c)",
        },
        secondaryColor: {
          type: "string",
          description: "Secondary color hex",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Style tags (max 12)",
        },
        brand: { type: "string", description: "Brand name" },
        product_name: { type: "string", description: "Product name" },
      },
      required: ["name", "part"],
    },
  },
  {
    name: "remove_wardrobe_item",
    description: "Remove an item from the wardrobe by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Wardrobe item ID to remove" },
      },
      required: ["id"],
    },
  },

  // ─── Outfits (3 tools, free) ───────────────────────────
  {
    name: "get_outfit_history",
    description:
      "Get the user's outfit history. Returns name, garments, status, description, and style tags.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "make_outfit",
    description:
      "Create a new outfit from 2-6 wardrobe items. AI will generate an outfit image (~130 seconds).",
    inputSchema: {
      type: "object" as const,
      properties: {
        garment_ids: {
          type: "array",
          items: { type: "string" },
          description: "2-6 wardrobe item IDs to combine",
        },
        name: {
          type: "string",
          description: "Outfit name (optional)",
        },
        setting: {
          type: "string",
          description:
            "Scene description (e.g. 'casual day at the park')",
        },
      },
      required: ["garment_ids"],
    },
  },
  {
    name: "suggest_outfits",
    description:
      "Get outfit suggestions based on the user's current wardrobe. Combines tops + bottoms + optional outer/shoes.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },

  // ─── Try-on (2 tools, free experimental) ────────────────
  {
    name: "try_on",
    description:
      "Start a virtual try-on for an outfit. Free experimental feature — no credits deducted. Returns a try-on job ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        outfit_id: {
          type: "string",
          description: "Outfit ID to try on",
        },
      },
      required: ["outfit_id"],
    },
  },
  {
    name: "get_tryon_result",
    description: "Get the result of a try-on job by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Try-on job ID" },
      },
      required: ["id"],
    },
  },

  // ─── Find & Shop (1 tool, 5 credits) ───────────────────
  {
    name: "find_matching_product",
    description:
      "Find matching products for a wardrobe item. Costs 5 credits. Returns brand, product name, colorway, confidence, and source URLs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        item_id: {
          type: "string",
          description: "Wardrobe item ID to find matching products for",
        },
      },
      required: ["item_id"],
    },
  },

  // ─── Planner (3 tools, free) ───────────────────────────
  {
    name: "get_planned_outfits",
    description: "Get planned outfits for a date range.",
    inputSchema: {
      type: "object" as const,
      properties: {
        start_date: {
          type: "string",
          description: "Start date (YYYY-MM-DD)",
        },
        end_date: {
          type: "string",
          description: "End date (YYYY-MM-DD)",
        },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "plan_outfit",
    description:
      "Plan an outfit for a specific date. Creates or updates the planner entry for that date.",
    inputSchema: {
      type: "object" as const,
      properties: {
        date: {
          type: "string",
          description: "Date (YYYY-MM-DD)",
        },
        outfit_id: {
          type: "string",
          description: "Outfit ID to assign",
        },
        note: { type: "string", description: "Optional note" },
      },
      required: ["date"],
    },
  },
  {
    name: "mark_outfit_worn",
    description:
      "Mark a planned outfit as actually worn (or un-worn) for a given date.",
    inputSchema: {
      type: "object" as const,
      properties: {
        entry_id: {
          type: "string",
          description: "Planner entry ID",
        },
        worn: {
          type: "boolean",
          description: "True to mark as worn, false to un-mark",
        },
      },
      required: ["entry_id", "worn"],
    },
  },

  // ─── Style Profile (2 tools, free) ─────────────────────
  {
    name: "get_style_profile",
    description:
      "Get the user's style profile — top colors, tags, part distribution, and wardrobe stats.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "update_style_profile",
    description:
      "Update the user's display name. Full profile is auto-derived from wardrobe items.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "New display name (max 120 chars)",
        },
      },
    },
  },
];

// ─── Internal Queries (MCP-specific, userId as parameter) ────────
// httpActions have no auth context, so we need internal functions
// that accept userId explicitly and skip the auth check.

/** Validate MCP API key → return userId or null. */
export const validateApiKey = internalQuery({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_mcp_api_key", (q) => q.eq("mcpApiKey", apiKey))
      .first();
    return profile?.userId ?? null;
  },
});

/** Get all wardrobe items for a user. */
export const mcpGetWardrobe = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const items = await ctx.db
      .query("wardrobeItems")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return Promise.all(
      items.map(async (item) => ({
        ...item,
        garmentUrl: item.garmentStorageId
          ? await ctx.storage.getUrl(item.garmentStorageId)
          : null,
        modeledUrl: item.modeledStorageId
          ? await ctx.storage.getUrl(item.modeledStorageId)
          : null,
      }))
    );
  },
});

/** Get a single wardrobe item for a user. */
export const mcpGetWardrobeItem = internalQuery({
  args: { userId: v.id("users"), itemId: v.id("wardrobeItems") },
  handler: async (ctx, { userId, itemId }) => {
    const item = await ctx.db.get(itemId);
    if (!item || item.userId !== userId) return null;
    return {
      ...item,
      garmentUrl: item.garmentStorageId
        ? await ctx.storage.getUrl(item.garmentStorageId)
        : null,
      modeledUrl: item.modeledStorageId
        ? await ctx.storage.getUrl(item.modeledStorageId)
        : null,
    };
  },
});

/** Get all outfits for a user. */
export const mcpGetOutfits = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const outfits = await ctx.db
      .query("outfits")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    return Promise.all(
      outfits.map(async (outfit) => {
        const garments = await Promise.all(
          outfit.garmentIds.map(async (gid) => {
            const item = await ctx.db.get(gid);
            return item
              ? {
                  _id: item._id,
                  name: item.name,
                  part: item.part,
                  color: item.color,
                  tags: item.tags,
                }
              : null;
          })
        );
        return {
          ...outfit,
          garments: garments.filter(Boolean),
          imageUrl: outfit.imageStorageId
            ? await ctx.storage.getUrl(outfit.imageStorageId)
            : null,
        };
      })
    );
  },
});

/** Get planner entries for a date range. */
export const mcpGetPlanner = internalQuery({
  args: {
    userId: v.id("users"),
    startDate: v.string(),
    endDate: v.string(),
  },
  handler: async (ctx, { userId, startDate, endDate }) => {
    const entries = await ctx.db
      .query("plannerEntries")
      .withIndex("by_user_date", (q) =>
        q.eq("userId", userId).gte("date", startDate).lte("date", endDate)
      )
      .collect();
    return Promise.all(
      entries.map(async (entry) => {
        if (entry.outfitId) {
          const outfit = await ctx.db.get(entry.outfitId);
          return {
            ...entry,
            outfit: outfit
              ? {
                  _id: outfit._id,
                  name: outfit.name,
                  status: outfit.status,
                }
              : null,
          };
        }
        return entry;
      })
    );
  },
});

/** Get user's style profile. */
export const mcpGetProfile = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user) return null;

    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

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
      plan: profile?.plan ?? "free",
      creditBalance: profile?.creditBalance ?? 0,
      wardrobeCount: items.length,
      partDistribution: partCounts,
      topColors,
      topTags,
    };
  },
});

// ─── Internal Mutations (MCP-specific, userId as parameter) ──────

/** Add a wardrobe item for a user. */
export const mcpAddItem = internalMutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
    part: v.string(),
    color: v.optional(v.string()),
    secondaryColor: v.optional(v.union(v.string(), v.null())),
    tags: v.optional(v.array(v.string())),
    brand: v.optional(v.string()),
    productName: v.optional(v.string()),
  },
  handler: async (ctx, { userId, name, part, color, secondaryColor, tags, brand, productName }) => {
    const sanitizedName = name.slice(0, 120);
    const sanitizedTags = (tags || []).slice(0, 12).map((t) => t.slice(0, 40).toLowerCase());
    const sanitizedColor = color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : "#333333";

    return ctx.db.insert("wardrobeItems", {
      userId,
      name: sanitizedName,
      part: part as any,
      color: sanitizedColor,
      secondaryColor: secondaryColor || null,
      tags: sanitizedTags,
      brand,
      productName,
    });
  },
});

/** Delete a wardrobe item for a user. */
export const mcpDeleteItem = internalMutation({
  args: { userId: v.id("users"), itemId: v.id("wardrobeItems") },
  handler: async (ctx, { userId, itemId }) => {
    const item = await ctx.db.get(itemId);
    if (!item || item.userId !== userId) throw new Error("Not found");

    // Remove from any outfits referencing this item
    const outfits = await ctx.db
      .query("outfits")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const outfit of outfits) {
      if (outfit.garmentIds.includes(itemId)) {
        const updatedIds = outfit.garmentIds.filter((gid) => gid !== itemId);
        if (updatedIds.length === 0) {
          if (outfit.imageStorageId) await ctx.storage.delete(outfit.imageStorageId);
          await ctx.db.delete(outfit._id);
        } else {
          await ctx.db.patch(outfit._id, { garmentIds: updatedIds });
        }
      }
    }

    if (item.garmentStorageId) await ctx.storage.delete(item.garmentStorageId);
    if (item.modeledStorageId) await ctx.storage.delete(item.modeledStorageId);
    if (item.sourceStorageId) await ctx.storage.delete(item.sourceStorageId);
    await ctx.db.delete(itemId);
    return { deleted: true };
  },
});

/** Create an outfit for a user. */
export const mcpCreateOutfit = internalMutation({
  args: {
    userId: v.id("users"),
    garmentIds: v.array(v.id("wardrobeItems")),
    name: v.optional(v.string()),
    setting: v.optional(v.string()),
  },
  handler: async (ctx, { userId, garmentIds, name, setting }) => {
    const dedupedIds = [...new Set(garmentIds)];
    if (dedupedIds.length < 2 || dedupedIds.length > 6) {
      throw new Error("Outfit must have 2-6 garments");
    }
    for (const gid of dedupedIds) {
      const item = await ctx.db.get(gid);
      if (!item || item.userId !== userId) throw new Error(`Garment ${gid} not found`);
    }

    const outfitId = await ctx.db.insert("outfits", {
      userId,
      name: (name || "Untitled Outfit").slice(0, 120),
      garmentIds: dedupedIds,
      setting: setting?.slice(0, 300),
      status: "generating",
      tags: [],
    });

    await ctx.scheduler.runAfter(0, "outfits:generateOutfitImage", { outfitId });
    return outfitId;
  },
});

/** Plan an outfit for a user. */
export const mcpPlanOutfit = internalMutation({
  args: {
    userId: v.id("users"),
    date: v.string(),
    outfitId: v.optional(v.id("outfits")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { userId, date, outfitId, note }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("Date must be YYYY-MM-DD format");
    }
    if (outfitId) {
      const outfit = await ctx.db.get(outfitId);
      if (!outfit || outfit.userId !== userId) throw new Error("Outfit not found");
    }

    const existing = await ctx.db
      .query("plannerEntries")
      .withIndex("by_user_date", (q) => q.eq("userId", userId).eq("date", date))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        outfitId: outfitId ?? existing.outfitId,
        note: note ?? existing.note,
      });
      return existing._id;
    }

    return ctx.db.insert("plannerEntries", { userId, date, outfitId, note });
  },
});

/** Mark a planner entry as worn/unworn for a user. */
export const mcpMarkWorn = internalMutation({
  args: {
    userId: v.id("users"),
    entryId: v.id("plannerEntries"),
    worn: v.boolean(),
  },
  handler: async (ctx, { userId, entryId, worn }) => {
    const entry = await ctx.db.get(entryId);
    if (!entry || entry.userId !== userId) throw new Error("Not found");
    await ctx.db.patch(entryId, { worn });
    return { updated: true };
  },
});

/** Update user display name. */
export const mcpUpdateProfile = internalMutation({
  args: {
    userId: v.id("users"),
    name: v.optional(v.string()),
  },
  handler: async (ctx, { userId, name }) => {
    const patches: Record<string, any> = {};
    if (name) patches.name = name.slice(0, 120);
    if (Object.keys(patches).length > 0) {
      await ctx.db.patch(userId, patches);
    }
    return { updated: true };
  },
});

/** Start a try-on for a user. */
export const mcpStartTryon = internalMutation({
  args: {
    userId: v.id("users"),
    outfitId: v.id("outfits"),
  },
  handler: async (ctx, { userId, outfitId }) => {
    const outfit = await ctx.db.get(outfitId);
    if (!outfit || outfit.userId !== userId) throw new Error("Outfit not found");
    if (outfit.status !== "ready") throw new Error("Outfit not ready for try-on");

    // Rate limit: max 5 active jobs per outfit
    const existingJobs = await ctx.db
      .query("tryonJobs")
      .withIndex("by_outfit", (q) => q.eq("outfitId", outfitId))
      .collect();
    const activeCount = existingJobs.filter(
      (j) => j.status === "pending" || j.status === "processing"
    ).length;
    if (activeCount >= 5) {
      throw new Error("Too many try-on requests for this outfit. Wait for existing ones to complete.");
    }

    const jobId = await ctx.db.insert("tryonJobs", {
      userId,
      outfitId,
      status: "pending",
    });

    await ctx.scheduler.runAfter(0, "tryon:processTryon", { jobId });
    return { jobId };
  },
});

/** Get a try-on result for a user. */
export const mcpGetTryonResult = internalQuery({
  args: {
    userId: v.id("users"),
    jobId: v.id("tryonJobs"),
  },
  handler: async (ctx, { userId, jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.userId !== userId) return null;
    return {
      ...job,
      imageUrl: job.imageStorageId
        ? await ctx.storage.getUrl(job.imageStorageId)
        : null,
    };
  },
});

// ─── MCP JSON-RPC Protocol Handler ──────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Mcp-Session-Id",
};

export async function handleMcpRequest(
  ctx: any,
  request: Request
): Promise<Response> {
  try {
    const body = await request.json();
    const { jsonrpc, method, params, id } = body;

    if (jsonrpc !== "2.0") {
      return jsonResponse(
        {
          jsonrpc: "2.0",
          id,
          error: { code: -32600, message: "Invalid Request" },
        },
        CORS_HEADERS
      );
    }

    let result: any;
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "wardrobe-mcp", version: "1.0.0" },
        };
        break;
      case "initialized":
        // Notification — no response needed (client acknowledges init)
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      case "tools/list":
        result = { tools: MCP_TOOLS };
        break;
      case "tools/call":
        result = await handleToolsCall(ctx, request, params);
        break;
      default:
        return jsonResponse(
          {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          },
          CORS_HEADERS
        );
    }

    return jsonResponse({ jsonrpc: "2.0", id, result }, CORS_HEADERS);
  } catch (e: any) {
    return jsonResponse(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: e.message || "Internal error" },
      },
      CORS_HEADERS
    );
  }
}

export function handleCorsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

// ─── Auth ───────────────────────────────────────────────────────

/**
 * Authenticate MCP requests via API key.
 *
 * Users generate an API key from the Profile page (mcpApiKey stored in
 * userProfiles). The Bearer token must match this key.
 *
 * This is secure because:
 *   - Keys are long random strings (wrd_<uuid>), not guessable user IDs
 *   - Users can revoke/regenerate keys at any time
 *   - Each key maps to exactly one user via a DB index
 */
async function authenticate(request: Request, ctx: any): Promise<string> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error(
      "Missing Authorization header. Provide: Bearer <mcpApiKey>"
    );
  }
  const apiKey = authHeader.slice(7);
  if (!apiKey) throw new Error("Empty Bearer token");

  const userId = await ctx.runQuery(api.mcp.validateApiKey, { apiKey });
  if (!userId) {
    throw new Error("Invalid API key. Generate one from your Profile page.");
  }
  return userId;
}

// ─── Tools Call Router ───────────────────────────────────────────

async function handleToolsCall(
  ctx: any,
  request: Request,
  params: any
): Promise<any> {
  const { name, arguments: args } = params;
  const userId = await authenticate(request, ctx);

  switch (name) {
    // ─── Wardrobe ─────────────────────────────────────────
    case "get_wardrobe": {
      const items = await ctx.runQuery(api.mcp.mcpGetWardrobe, { userId });
      return toolResult(items, [
        `Wardrobe has ${items.length} items. Each has: name, part, color, tags.`,
      ]);
    }
    case "get_wardrobe_item": {
      const item = await ctx.runQuery(api.mcp.mcpGetWardrobeItem, {
        userId,
        itemId: args.id,
      });
      if (!item) return toolError("Item not found");
      return toolResult([item], ["Details of the requested item."]);
    }
    case "add_wardrobe_item": {
      const itemId = await ctx.runMutation(api.mcp.mcpAddItem, {
        userId,
        name: args.name,
        part: args.part,
        color: args.color,
        secondaryColor: args.secondaryColor,
        tags: args.tags,
        brand: args.brand,
        productName: args.product_name,
      });
      return toolResult([{ id: itemId }], [
        "Item added to wardrobe.",
        "Note: For full item creation with images, use the web app upload flow.",
      ]);
    }
    case "remove_wardrobe_item": {
      await ctx.runMutation(api.mcp.mcpDeleteItem, {
        userId,
        itemId: args.id,
      });
      return toolResult([{ id: args.id, deleted: true }], [
        "Item removed from wardrobe.",
      ]);
    }

    // ─── Outfits ──────────────────────────────────────────
    case "get_outfit_history": {
      const outfits = await ctx.runQuery(api.mcp.mcpGetOutfits, { userId });
      const simplified = outfits.map((o: any) => ({
        id: o._id,
        name: o.name,
        garments: o.garments?.map((g: any) => ({
          id: g._id,
          name: g.name,
          part: g.part,
          color: g.color,
        })),
        garmentIds: o.garmentIds,
        status: o.status,
        description: o.description,
        tags: o.tags,
      }));
      return toolResult(simplified, [
        `Found ${outfits.length} outfits. Status: generating, ready, failed, stalled.`,
      ]);
    }
    case "make_outfit": {
      const outfitId = await ctx.runMutation(api.mcp.mcpCreateOutfit, {
        userId,
        garmentIds: args.garment_ids,
        name: args.name,
        setting: args.setting,
      });
      return toolResult(
        [{ id: outfitId, status: "generating" }],
        [
          "Outfit creation started. AI is generating the image (~130s).",
          "Use get_outfit_history to check when it's ready.",
        ]
      );
    }
    case "suggest_outfits": {
      const items = await ctx.runQuery(api.mcp.mcpGetWardrobe, { userId });
      if (items.length < 2)
        return toolResult([], [
          "Need at least 2 items to suggest outfits.",
        ]);

      const byPart: Record<string, any[]> = {};
      for (const item of items) {
        if (!byPart[item.part]) byPart[item.part] = [];
        byPart[item.part].push(item);
      }

      const suggestions: any[] = [];
      const tops = byPart["upperbody"] || [];
      const bottoms = byPart["lowerbody"] || [];
      const outer = byPart["wholebody_up"] || [];
      const shoes = byPart["shoes"] || [];

      for (const top of tops.slice(0, 5)) {
        for (const bottom of bottoms.slice(0, 5)) {
          const ids = [top._id, bottom._id];
          const names = [top.name, bottom.name];
          if (outer.length > 0) {
            ids.push(outer[0]._id);
            names.push(outer[0].name + " (outer)");
          }
          if (shoes.length > 0) {
            ids.push(shoes[0]._id);
            names.push(shoes[0].name + " (shoes)");
          }
          suggestions.push({ garment_ids: ids, garment_names: names });
        }
      }

      return toolResult(suggestions.slice(0, 10), [
        `${suggestions.length} combos from ${items.length} items. Use make_outfit with garment_ids to create one.`,
      ]);
    }

    // ─── Try-on (free experimental) ──────────────────────
    case "try_on": {
      const { jobId } = await ctx.runMutation(api.mcp.mcpStartTryon, {
        userId,
        outfitId: args.outfit_id,
      });
      return toolResult(
        [{ id: jobId, status: "pending" }],
        [
          "Try-on started (free experimental feature).",
          "Use get_tryon_result to check status (~5 min).",
        ]
      );
    }
    case "get_tryon_result": {
      const result = await ctx.runQuery(api.mcp.mcpGetTryonResult, {
        userId,
        jobId: args.id,
      });
      if (!result) return toolError("Try-on job not found");
      return toolResult([result], [
        `Status: ${result.status}. Done = image URL available.`,
      ]);
    }

    // ─── Find & Shop ────────────────────────────────────
    case "find_matching_product": {
      // Delegate to the existing productMatch action, but we need
      // to run it with user context. Since we can't pass userId to a
      // public action, we return existing product match data instead.
      const item = await ctx.runQuery(api.mcp.mcpGetWardrobeItem, {
        userId,
        itemId: args.item_id,
      });
      if (!item) return toolError("Item not found");

      // Return existing product match if available
      if (item.brand || item.productName) {
        return toolResult(
          [{
            brand: item.brand,
            productName: item.productName,
            productColorway: item.productColorway,
            productUrl: item.productUrl,
            productConfidence: item.productConfidence,
            productEvidence: item.productEvidence,
            productMatchSummary: item.productMatchSummary,
          }],
          [
            "Existing product match found. For a fresh search, use the web app.",
          ]
        );
      }

      return toolResult([], [
        "No product match data yet. Use the web app to run a product search (costs 5 credits).",
      ]);
    }

    // ─── Planner ──────────────────────────────────────────
    case "get_planned_outfits": {
      const entries = await ctx.runQuery(api.mcp.mcpGetPlanner, {
        userId,
        startDate: args.start_date,
        endDate: args.end_date,
      });
      return toolResult(entries, [
        `Planned outfits from ${args.start_date} to ${args.end_date}.`,
      ]);
    }
    case "plan_outfit": {
      const entryId = await ctx.runMutation(api.mcp.mcpPlanOutfit, {
        userId,
        date: args.date,
        outfitId: args.outfit_id,
        note: args.note,
      });
      return toolResult(
        [{ id: entryId, date: args.date }],
        ["Outfit planned for " + args.date + "."]
      );
    }
    case "mark_outfit_worn": {
      await ctx.runMutation(api.mcp.mcpMarkWorn, {
        userId,
        entryId: args.entry_id,
        worn: args.worn,
      });
      return toolResult(
        [{ entry_id: args.entry_id, worn: args.worn }],
        [args.worn ? "Marked as worn." : "Un-marked as worn."]
      );
    }

    // ─── Style Profile ───────────────────────────────────
    case "get_style_profile": {
      const profile = await ctx.runQuery(api.mcp.mcpGetProfile, { userId });
      if (!profile) return toolError("Profile not found");
      return toolResult([profile], [
        "Style profile derived from wardrobe data.",
      ]);
    }
    case "update_style_profile": {
      if (args.name) {
        await ctx.runMutation(api.mcp.mcpUpdateProfile, {
          userId,
          name: args.name,
        });
      }
      return toolResult([{ updated: true }], [
        "Profile updated. Full style profile is auto-derived from wardrobe items.",
      ]);
    }

    default:
      throw new Error(`Tool not implemented: ${name}`);
  }
}

// ─── Response helpers ────────────────────────────────────────────

function jsonResponse(
  body: any,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function toolResult(data: any[], hints: string[] = []): any {
  return {
    content: [
      { type: "text", text: JSON.stringify(data, null, 2) },
      ...hints.map((h) => ({ type: "text" as const, text: h })),
    ],
  };
}

function toolError(message: string): any {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}
