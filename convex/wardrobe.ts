import { v } from "convex/values";
import { query, mutation, action, internalQuery, internalMutation } from "./_generated/server";
import { requireAuthedUserId, ensureUserFields, sanitizeColor } from "./helpers";
import { getAuthUserId } from "@convex-dev/auth/server";

// ─── Internal helpers (for actions, which lack ctx.db) ───────────

/** Internal: read a single wardrobe item by ID (no auth check — caller must verify). */
export const getWardrobeItemById = internalQuery({
  args: { itemId: v.id("wardrobeItems") },
  handler: async (ctx, { itemId }) => {
    return await ctx.db.get(itemId);
  },
});

/** Internal: patch product match results onto a wardrobe item. */
export const patchItemProductMatch = internalMutation({
  args: {
    itemId: v.id("wardrobeItems"),
    brand: v.union(v.string(), v.null()),
    productName: v.union(v.string(), v.null()),
    productColorway: v.union(v.string(), v.null()),
    productUrl: v.union(v.string(), v.null()),
    productConfidence: v.union(v.literal("exact"), v.literal("likely"), v.literal("unknown")),
    productEvidence: v.array(v.string()),
    productSources: v.array(v.object({ url: v.string(), title: v.optional(v.string()) })),
    productMatchSummary: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.itemId, {
      brand: args.brand,
      productName: args.productName,
      productColorway: args.productColorway,
      productUrl: args.productUrl,
      productConfidence: args.productConfidence,
      productEvidence: args.productEvidence,
      productSources: args.productSources,
      productMatchSummary: args.productMatchSummary,
    });
  },
});

// ─── Queries ────────────────────────────────────────────────────

/** Get all wardrobe items for the current user. */
export const getWardrobe = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuthedUserId(ctx);
    const items = await ctx.db
      .query("wardrobeItems")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    // Attach image URLs
    return Promise.all(
      items.map(async (item) => ({
        ...item,
        garmentUrl: item.garmentStorageId
          ? await ctx.storage.getUrl(item.garmentStorageId)
          : null,
        modeledUrl: item.modeledStorageId
          ? await ctx.storage.getUrl(item.modeledStorageId)
          : null,
        sourceUrl: item.sourceStorageId
          ? await ctx.storage.getUrl(item.sourceStorageId)
          : null,
      }))
    );
  },
});

/** Get a single wardrobe item. */
export const getWardrobeItem = query({
  args: { id: v.id("wardrobeItems") },
  handler: async (ctx, { id }) => {
    const userId = await requireAuthedUserId(ctx);
    const item = await ctx.db.get(id);
    if (!item || item.userId !== userId) return null;
    return {
      ...item,
      garmentUrl: item.garmentStorageId
        ? await ctx.storage.getUrl(item.garmentStorageId)
        : null,
      modeledUrl: item.modeledStorageId
        ? await ctx.storage.getUrl(item.modeledStorageId)
        : null,
      sourceUrl: item.sourceStorageId
        ? await ctx.storage.getUrl(item.sourceStorageId)
        : null,
    };
  },
});

/** Get wardrobe items filtered by part. */
export const getWardrobeByPart = query({
  args: { part: v.string() },
  handler: async (ctx, { part }) => {
    const userId = await requireAuthedUserId(ctx);
    const items = await ctx.db
      .query("wardrobeItems")
      .withIndex("by_user_part", (q) =>
        q.eq("userId", userId).eq("part", part)
      )
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
        sourceUrl: item.sourceStorageId
          ? await ctx.storage.getUrl(item.sourceStorageId)
          : null,
      }))
    );
  },
});

// ─── Mutations ──────────────────────────────────────────────────

/** Generate an upload URL for the client to POST a file to Convex Storage. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAuthedUserId(ctx);
    return ctx.storage.generateUploadUrl();
  },
});

/** Add a wardrobe item (after images are uploaded via generateUploadUrl). */
export const addWardrobeItem = mutation({
  args: {
    name: v.string(),
    part: v.string(),
    color: v.string(),
    secondaryColor: v.optional(v.union(v.string(), v.null())),
    tags: v.array(v.string()),
    garmentStorageId: v.optional(v.id("_storage")),
    modeledStorageId: v.optional(v.id("_storage")),
    sourceStorageId: v.optional(v.id("_storage")),
    importJobId: v.optional(v.string()),
    brand: v.optional(v.string()),
    productName: v.optional(v.string()),
    productColorway: v.optional(v.string()),
    productUrl: v.optional(v.string()),
    productConfidence: v.optional(v.string()),
    productEvidence: v.optional(v.array(v.string())),
    productSources: v.optional(
      v.array(v.object({ url: v.string(), title: v.optional(v.string()) }))
    ),
    productMatchSummary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuthedUserId(ctx);
    // Clamp fields
    const name = args.name.slice(0, 120);
    const tags = args.tags.slice(0, 12).map((t) => t.slice(0, 40).toLowerCase());
    const color = (sanitizeColor(args.color) ?? "#d8d0c2") as string;
    const secondaryColor = sanitizeColor(args.secondaryColor);

    return ctx.db.insert("wardrobeItems", {
      userId,
      name,
      part: args.part as any,
      color,
      secondaryColor,
      tags,
      garmentStorageId: args.garmentStorageId,
      modeledStorageId: args.modeledStorageId,
      sourceStorageId: args.sourceStorageId,
      importJobId: args.importJobId,
      brand: args.brand,
      productName: args.productName,
      productColorway: args.productColorway,
      productUrl: args.productUrl,
      productConfidence: args.productConfidence as any,
      productEvidence: args.productEvidence,
      productSources: args.productSources,
      productMatchSummary: args.productMatchSummary,
    });
  },
});

/** Update a wardrobe item (partial patch). */
export const updateWardrobeItem = mutation({
  args: {
    id: v.id("wardrobeItems"),
    name: v.optional(v.string()),
    part: v.optional(v.string()),
    color: v.optional(v.string()),
    secondaryColor: v.optional(v.union(v.string(), v.null())),
    tags: v.optional(v.array(v.string())),
    garmentStorageId: v.optional(v.id("_storage")),
    modeledStorageId: v.optional(v.id("_storage")),
    sourceStorageId: v.optional(v.id("_storage")),
    brand: v.optional(v.string()),
    productName: v.optional(v.string()),
    productColorway: v.optional(v.string()),
    productUrl: v.optional(v.string()),
    productConfidence: v.optional(v.string()),
    productEvidence: v.optional(v.array(v.string())),
    productSources: v.optional(
      v.array(v.object({ url: v.string(), title: v.optional(v.string()) }))
    ),
    productMatchSummary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuthedUserId(ctx);
    const item = await ctx.db.get(args.id);
    if (!item || item.userId !== userId) throw new Error("Not found");
    const { id, ...updates } = args;
    // Clamp
    if (updates.name) updates.name = updates.name.slice(0, 120);
    if (updates.tags) updates.tags = updates.tags.slice(0, 12).map((t) => t.slice(0, 40).toLowerCase());
    if (updates.color !== undefined) updates.color = (sanitizeColor(updates.color) ?? "#d8d0c2") as string;
    if (updates.secondaryColor !== undefined) updates.secondaryColor = sanitizeColor(updates.secondaryColor);
    if (updates.part) updates.part = updates.part as any;
    if (updates.productConfidence) updates.productConfidence = updates.productConfidence as any;
    await ctx.db.patch(id, updates);
  },
});

/** Delete a wardrobe item and its stored images. */
export const deleteWardrobeItem = mutation({
  args: { id: v.id("wardrobeItems") },
  handler: async (ctx, { id }) => {
    const userId = await requireAuthedUserId(ctx);
    const item = await ctx.db.get(id);
    if (!item || item.userId !== userId) throw new Error("Not found");
    // Clean up images from storage
    if (item.garmentStorageId) await ctx.storage.delete(item.garmentStorageId);
    if (item.modeledStorageId) await ctx.storage.delete(item.modeledStorageId);
    if (item.sourceStorageId) await ctx.storage.delete(item.sourceStorageId);
    await ctx.db.delete(id);
  },
});

// ─── Actions (server-side OpenAI calls) ─────────────────────────

/** Analyze a photo to detect clothing items. Returns metadata for each. */
export const analyzePhoto = action({
  args: {
    storageId: v.id("_storage"), // uploaded photo
  },
  handler: async (ctx, { storageId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const imageUrl = await ctx.storage.getUrl(storageId);
    if (!imageUrl) throw new Error("Image not found in storage");

    const baseUrl = process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1";
    const model = process.env.OPENAI_VISION_MODEL || "gpt-5.4-mini";

    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: `Identify every distinct wearable clothing item visible in this image. For each item provide: name (max 60 chars), part (upperbody/lowerbody/wholebody_up/accessories_up/shoes), primary color (hex), secondary color (hex or null), and up to 4 style tags. Return as JSON array.` },
            { type: "input_image", image_url: imageUrl, detail: "high" },
          ],
        }],
        text: {
          format: {
            type: "json_schema",
            name: "wardrobe_items",
            schema: {
              type: "object",
              properties: {
                items: {
                  type: "array",
                  maxItems: 8,
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string", maxLength: 60 },
                      part: {
                        type: "string",
                        enum: ["upperbody", "lowerbody", "wholebody_up", "accessories_up", "shoes"],
                      },
                      color: { type: "string" },
                      secondaryColor: { type: ["string", "null"] },
                      tags: { type: "array", maxItems: 4, items: { type: "string" } },
                    },
                    required: ["name", "part", "color", "secondaryColor", "tags"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["items"],
              additionalProperties: false,
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI analyze failed: ${response.status} ${err}`);
    }

    const data = await response.json();
    const parsed = JSON.parse(data.output[0].content[0].text);
    // Defensively strip sentinel-string colors ("null", "none", "") that
    // the model occasionally emits before returning to the caller.
    if (parsed && Array.isArray(parsed.items)) {
      parsed.items = parsed.items.map((it: any) => ({
        ...it,
        color: sanitizeColor(it?.color) ?? "#d8d0c2",
        secondaryColor: sanitizeColor(it?.secondaryColor),
      }));
    }
    return parsed;
  },
});

/** Run product match on a wardrobe item's garment image. */
export const productMatch = action({
  args: {
    itemId: v.id("wardrobeItems"),
  },
  handler: async (ctx, { itemId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    // Read item from DB
    const item = await ctx.runQuery("wardrobe:getWardrobeItemById", { itemId });
    if (!item || item.userId !== userId) throw new Error("Not found");

    const imageUrl = await ctx.storage.getUrl(item.garmentStorageId);
    if (!imageUrl) throw new Error("Garment image not found");

    const baseUrl = process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1";
    const model = process.env.OPENAI_PRODUCT_MODEL || process.env.OPENAI_VISION_MODEL || "gpt-5.4-mini";

    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        tools: [
          {
            type: "web_search",
            search_context_size: "medium",
          },
        ],
        tool_choice: "required",
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: `Compare this garment against official brand pages and resale listings. Identify: brand, product name, colorway, confidence (exact/likely/unknown), identifying features (up to 6), summary reasoning, and a source URL with title.` },
            { type: "input_image", image_url: imageUrl, detail: "high" },
          ],
        }],
        text: {
          format: {
            type: "json_schema",
            name: "product_match",
            schema: {
              type: "object",
              properties: {
                brand: { type: ["string", "null"] },
                productName: { type: ["string", "null"] },
                colorway: { type: ["string", "null"] },
                confidence: { type: "string", enum: ["exact", "likely", "unknown"] },
                identifyingFeatures: { type: "array", maxItems: 6, items: { type: "string" } },
                summary: { type: "string" },
                sourceUrl: { type: ["string", "null"] },
                sourceTitle: { type: ["string", "null"] },
              },
              required: ["brand", "productName", "colorway", "confidence", "identifyingFeatures", "summary", "sourceUrl", "sourceTitle"],
              additionalProperties: false,
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Product match failed: ${response.status} ${err}`);
    }

    const data = await response.json();

    // The Responses API with the web_search tool returns output items in order:
    // web_search_call(s) first, then the final assistant message. Find the
    // message item rather than hardcoding output[0] (which would be the search call).
    const messageItem = data.output?.find((item: any) => item.type === "message");
    const contentItem = messageItem?.content?.find((c: any) => c.type === "output_text")
      || messageItem?.content?.[0];
    if (!contentItem?.text) {
      throw new Error("Product match returned no message text");
    }
    const parsed = JSON.parse(contentItem.text);

    // Extract web search sources from URL citation annotations (built-in
    // web_search tool) with a function_call_output fallback (custom tools).
    const sources: { url: string; title?: string }[] = [];
    const annotations = contentItem.annotations;
    if (Array.isArray(annotations)) {
      for (const ann of annotations) {
        if (ann.type === "url_citation" && ann.url) {
          sources.push({ url: ann.url, title: ann.title });
        }
      }
    }
    if (sources.length === 0) {
      for (const item of data.output || []) {
        if (item.type === "function_call_output") {
          try {
            const searchResult = JSON.parse(item.output);
            if (Array.isArray(searchResult)) {
              for (const s of searchResult.slice(0, 8)) {
                if (s.url) sources.push({ url: s.url, title: s.title });
              }
            }
          } catch {}
        }
      }
    }

    // Cross-reference: downgrade exact → likely if missing key fields
    let confidence = parsed.confidence;
    if (confidence === "exact" && (!parsed.brand || !parsed.productName || !parsed.sourceUrl)) {
      confidence = "likely";
    }

    // Save results to the item in DB
    await ctx.runMutation("wardrobe:patchItemProductMatch", {
      itemId,
      brand: parsed.brand,
      productName: parsed.productName,
      productColorway: parsed.colorway,
      productUrl: parsed.sourceUrl,
      productConfidence: confidence as "exact" | "likely" | "unknown",
      productEvidence: parsed.identifyingFeatures?.slice(0, 6) || [],
      productSources: sources.slice(0, 8),
      productMatchSummary: parsed.summary,
    });

    return {
      brand: parsed.brand,
      productName: parsed.productName,
      productColorway: parsed.colorway,
      productUrl: parsed.sourceUrl,
      productConfidence: confidence,
      productEvidence: parsed.identifyingFeatures?.slice(0, 6) || [],
      productSources: sources.slice(0, 8),
      productMatchSummary: parsed.summary,
    };
  },
});
