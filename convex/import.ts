import { v } from "convex/values";
import { mutation, action, query } from "./_generated/server";
import { requireAuthedUserId } from "./helpers";

// ─── Import Pipeline ────────────────────────────────────────────
//
// This replaces the old import-job-api.mjs multi-stage pipeline.
// In Convex, we use actions (which can call OpenAI) and mutations (for DB writes).
//
// Flow:
// 1. Client uploads photo via generateUploadUrl
// 2. Client calls startImport with the storageId
// 3. startImport schedules analyzeUpload action
// 4. analyzeUpload calls OpenAI vision → detects items → creates wardrobe items
// 5. For each item: generateGarmentCutout → generateModeledPhoto (chained)
// 6. Optional: productMatch on each item
//
// Unlike the dev version, we do this synchronously in actions where possible
// since Convex handles concurrency and retries.
// ──────────────────────────────────────────────────────────────────

// ─── Queries ────────────────────────────────────────────────────

/** Get import status for a specific import job. */
export const getImportStatus = query({
  args: { importId: v.id("wardrobeItems") },
  handler: async (ctx, { importId }) => {
    const userId = await requireAuthedUserId(ctx);
    const item = await ctx.db.get(importId);
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

// ─── Mutations ──────────────────────────────────────────────────

/** Start an import from an uploaded photo. Kicks off the analysis pipeline. */
export const startImport = mutation({
  args: {
    sourceStorageId: v.id("_storage"),  // uploaded photo
    autoProcess: v.optional(v.boolean()), // if true, auto-approve all stages
  },
  handler: async (ctx, { sourceStorageId, autoProcess }) => {
    const userId = await requireAuthedUserId(ctx);

    // We'll create placeholder wardrobe items after analysis.
    // For now, schedule the analysis action.
    await ctx.scheduler.runAfter(0, "import:analyzeUpload", {
      userId,
      sourceStorageId,
      autoProcess: autoProcess ?? true,
    });

    return { status: "analyzing" };
  },
});

// ─── Actions ────────────────────────────────────────────────────

/** Analyze an uploaded photo and detect clothing items. */
export const analyzeUpload = action({
  args: {
    userId: v.id("users"),
    sourceStorageId: v.id("_storage"),
    autoProcess: v.boolean(),
  },
  handler: async (ctx, { userId, sourceStorageId, autoProcess }) => {
    const imageUrl = await ctx.storage.getUrl(sourceStorageId);
    if (!imageUrl) throw new Error("Source image not found");

    const baseUrl = process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1";
    const visionModel = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";

    // Call OpenAI to detect items
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: visionModel,
        input: [
          {
            type: "input_text",
            text: `Identify every distinct wearable clothing item visible in this image. For each item provide: name (max 60 chars), part (upperbody/lowerbody/wholebody_up/accessories_up/shoes), primary color (hex), secondary color (hex or null), and up to 4 style tags. Return as JSON array.`,
          },
          {
            type: "input_image",
            image_url: imageUrl,
            detail: "high",
          },
        ],
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

    // For each detected item, create a wardrobe item placeholder
    // then schedule garment cutout + modeled photo generation
    for (const item of parsed.items) {
      const itemId = await ctx.runMutation("import:createItemPlaceholder", {
        userId,
        name: item.name.slice(0, 120),
        part: item.part,
        color: item.color.toLowerCase(),
        secondaryColor: item.secondaryColor?.toLowerCase(),
        tags: (item.tags || []).slice(0, 4).map((t: string) => t.slice(0, 40).toLowerCase()),
        sourceStorageId,
      });

      if (autoProcess) {
        // Schedule the full pipeline: cutout → modeled → product match
        await ctx.scheduler.runAfter(0, "import:generateGarmentCutout", {
          itemId,
          sourceStorageId,
        });
      }
    }

    return { detectedItems: parsed.items.length };
  },
});

/** Create a placeholder wardrobe item (no images yet). */
export const createItemPlaceholder = mutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
    part: v.string(),
    color: v.string(),
    secondaryColor: v.optional(v.string()),
    tags: v.array(v.string()),
    sourceStorageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    // Placeholder: garmentStorageId is required by schema, but we don't have it yet.
    // We'll use the source image temporarily and update after cutout.
    return ctx.db.insert("wardrobeItems", {
      userId: args.userId,
      name: args.name,
      part: args.part as any,
      color: args.color,
      secondaryColor: args.secondaryColor,
      tags: args.tags,
      garmentStorageId: args.sourceStorageId, // temp placeholder
      sourceStorageId: args.sourceStorageId,
    });
  },
});

/** Generate a garment cutout from the source photo. */
export const generateGarmentCutout = action({
  args: {
    itemId: v.id("wardrobeItems"),
    sourceStorageId: v.id("_storage"),
  },
  handler: async (ctx, { itemId, sourceStorageId }) => {
    const item = await ctx.db.get(itemId);
    if (!item) throw new Error("Item not found");

    const sourceUrl = await ctx.storage.getUrl(sourceStorageId);
    if (!sourceUrl) throw new Error("Source image not found");

    const baseUrl = process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1";
    const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";

    // Choose chroma key far from garment color
    const chromaKey = chooseChromaKey(item.color);

    const prompt = `Create a professional ecommerce catalog cutout of this clothing item on a solid ${chromaKey} background. Preserve every detail of the garment — seams, texture, pattern, and color. The background must be perfectly uniform ${chromaKey} with no shadows, gradients, or artifacts. Do NOT modify the garment in any way.`;

    // Download source image
    const imageResp = await fetch(sourceUrl);
    const imageBlob = await imageResp.blob();

    const formData = new FormData();
    formData.append("model", imageModel);
    formData.append("prompt", prompt);
    formData.append("size", "1024x1024");
    formData.append("quality", process.env.OPENAI_IMAGE_QUALITY || "high");
    formData.append("output_format", "png");
    formData.append("image", imageBlob, "source.png");

    const response = await fetch(`${baseUrl}/images/edits`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Garment cutout failed for ${itemId}: ${response.status}`);
      // Don't throw — we'll leave the placeholder image
      return;
    }

    const result = await response.json();
    const imageBase64 = result.data?.[0]?.b64_json;
    if (!imageBase64) return;

    // Upload cutout to Convex storage
    const uploadUrl = await ctx.storage.generateUploadUrl();
    const uploadResp = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0)),
    });
    const { storageId: garmentStorageId } = await uploadResp.json();

    // Update the item with the real garment image
    await ctx.db.patch(itemId, { garmentStorageId });

    // Schedule modeled photo generation
    await ctx.scheduler.runAfter(0, "import:generateModeledPhoto", {
      itemId,
      garmentStorageId,
    });

    // Schedule product match (non-blocking)
    await ctx.scheduler.runAfter(0, "import:runProductMatch", {
      itemId,
    });
  },
});

/** Generate a modeled photo of the person wearing the garment. */
export const generateModeledPhoto = action({
  args: {
    itemId: v.id("wardrobeItems"),
    garmentStorageId: v.id("_storage"),
  },
  handler: async (ctx, { itemId, garmentStorageId }) => {
    const item = await ctx.db.get(itemId);
    if (!item) throw new Error("Item not found");

    const garmentUrl = await ctx.storage.getUrl(garmentStorageId);
    if (!garmentUrl) throw new Error("Garment image not found");

    // Get model reference(s) — stored in user's account
    // For now, we look for any existing modeled photos as reference
    // TODO: dedicated model-references table/storage
    const userId = item.userId;
    const existingItems = await ctx.db
      .query("wardrobeItems")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    // Find items with modeled photos to use as references
    const modelRefStorageIds = existingItems
      .filter((i) => i.modeledStorageId && i._id !== itemId)
      .map((i) => i.modeledStorageId!)
      .slice(0, 5); // max 5 references

    const baseUrl = process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1";
    const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";

    const prompt = `Generate a professional horizontal 3:2 editorial fashion photograph of a person wearing this garment. Preserve the person's identity exactly as shown in any reference photos. The garment must match exactly — same color, texture, pattern, and fit. Natural studio lighting, clean background.`;

    // Build multipart with model refs + garment
    const formData = new FormData();
    formData.append("model", imageModel);
    formData.append("prompt", prompt);
    formData.append("size", "1536x1024");
    formData.append("quality", process.env.OPENAI_IMAGE_QUALITY || "high");
    formData.append("output_format", "png");

    // Add model reference images
    for (let i = 0; i < modelRefStorageIds.length; i++) {
      const refUrl = await ctx.storage.getUrl(modelRefStorageIds[i]);
      if (refUrl) {
        const resp = await fetch(refUrl);
        formData.append("image", await resp.blob(), `ref${i}.png`);
      }
    }

    // Add the garment image
    const garmentResp = await fetch(garmentUrl);
    formData.append("image", await garmentResp.blob(), "garment.png");

    const response = await fetch(`${baseUrl}/images/edits`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: formData,
    });

    if (!response.ok) {
      console.error(`Modeled photo failed for ${itemId}: ${response.status}`);
      return;
    }

    const result = await response.json();
    const imageBase64 = result.data?.[0]?.b64_json;
    if (!imageBase64) return;

    // Upload to Convex storage
    const uploadUrl = await ctx.storage.generateUploadUrl();
    const uploadResp = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0)),
    });
    const { storageId: modeledStorageId } = await uploadResp.json();

    // Update the item
    await ctx.db.patch(itemId, { modeledStorageId });
  },
});

/** Run product match on a wardrobe item. */
export const runProductMatch = action({
  args: {
    itemId: v.id("wardrobeItems"),
  },
  handler: async (ctx, { itemId }) => {
    const item = await ctx.db.get(itemId);
    if (!item) throw new Error("Item not found");

    const imageUrl = await ctx.storage.getUrl(item.garmentStorageId);
    if (!imageUrl) return;

    const baseUrl = process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1";
    const model = process.env.OPENAI_PRODUCT_MODEL || process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";

    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        reasoning: { effort: "low" },
        tools: [{ type: "web_search", search_context_size: "medium" }],
        tool_choice: "required",
        input: [
          {
            type: "input_text",
            text: `Compare this garment against official brand pages and resale listings. Identify: brand, product name, colorway, confidence (exact/likely/unknown), identifying features (up to 6), summary reasoning, and a source URL with title.`,
          },
          {
            type: "input_image",
            image_url: imageUrl,
            detail: "high",
          },
        ],
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
      console.error(`Product match failed for ${itemId}: ${response.status}`);
      return;
    }

    const data = await response.json();
    const parsed = JSON.parse(data.output[0].content[0].text);

    // Downgrade exact → likely if missing key fields
    let confidence = parsed.confidence;
    if (confidence === "exact" && (!parsed.brand || !parsed.productName || !parsed.sourceUrl)) {
      confidence = "likely";
    }

    await ctx.db.patch(itemId, {
      brand: parsed.brand,
      productName: parsed.productName,
      productColorway: parsed.colorway,
      productUrl: parsed.sourceUrl,
      productConfidence: confidence,
      productEvidence: parsed.identifyingFeatures?.slice(0, 6) || [],
      productMatchSummary: parsed.summary?.slice(0, 500),
    });
  },
});

// ─── Helpers ────────────────────────────────────────────────────

/** Choose a chroma key color far from the garment's primary color. */
function chooseChromaKey(primaryColor: string): string {
  // Simple heuristic: parse hex, pick the most different chroma key
  const r = parseInt(primaryColor.slice(1, 3), 16);
  const g = parseInt(primaryColor.slice(3, 5), 16);
  const b = parseInt(primaryColor.slice(5, 7), 16);

  const options = [
    { name: "#00ff00", r: 0, g: 255, b: 0 },    // green
    { name: "#ff00ff", r: 255, g: 0, b: 255 },   // magenta
    { name: "#00ffff", r: 0, g: 255, b: 255 },    // cyan
  ];

  let maxDist = 0;
  let best = options[0].name;
  for (const opt of options) {
    const dist = Math.abs(r - opt.r) + Math.abs(g - opt.g) + Math.abs(b - opt.b);
    if (dist > maxDist) {
      maxDist = dist;
      best = opt.name;
    }
  }

  return best;
}
