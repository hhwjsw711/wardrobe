import { v } from "convex/values";
import { query, mutation, action, internalAction, internalQuery, internalMutation } from "./_generated/server";
import { requireAuthedUserId } from "./helpers";
import { safeRecord } from "./usage";

// ─── Internal helpers (for actions, which lack ctx.db) ───────────

const OutfitStatus = v.union(
  v.literal("generating"),
  v.literal("ready"),
  v.literal("failed"),
  v.literal("stalled"),
);

/** Internal: read a single outfit by ID. */
export const getOutfitById = internalQuery({
  args: { outfitId: v.id("outfits") },
  handler: async (ctx, { outfitId }) => {
    return await ctx.db.get(outfitId);
  },
});

/** Internal: read multiple wardrobe items by their IDs. */
export const getWardrobeItemsByIds = internalQuery({
  args: { ids: v.array(v.id("wardrobeItems")) },
  handler: async (ctx, { ids }) => {
    const results = await Promise.all(ids.map((id) => ctx.db.get(id)));
    return results.filter((x) => x !== null);
  },
});

/** Internal: patch an outfit with a subset of fields used by generateOutfitImage. */
export const patchOutfit = internalMutation({
  args: {
    outfitId: v.id("outfits"),
    status: v.optional(OutfitStatus),
    imageStorageId: v.optional(v.id("_storage")),
    error: v.optional(v.union(v.string(), v.null())),
    description: v.optional(v.union(v.string(), v.null())),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { outfitId, ...patch }) => {
    // Strip undefined so we don't null out fields we intended to leave alone
    const clean: Record<string, any> = {};
    for (const [k, val] of Object.entries(patch)) {
      if (val !== undefined) clean[k] = val;
    }
    await ctx.db.patch(outfitId, clean);
  },
});

// ─── Queries ────────────────────────────────────────────────────

/** Get all outfits for the current user. */
export const getOutfits = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuthedUserId(ctx);
    const outfits = await ctx.db
      .query("outfits")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();

    // Enrich with garment data and image URLs
    return Promise.all(
      outfits.map(async (outfit) => {
        const garments = await Promise.all(
          outfit.garmentIds.map(async (gid) => {
            const item = await ctx.db.get(gid);
            return item
              ? {
                  ...item,
                  garmentUrl: item.garmentStorageId
                    ? await ctx.storage.getUrl(item.garmentStorageId)
                    : null,
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

/** Get a single outfit by ID. */
export const getOutfit = query({
  args: { id: v.id("outfits") },
  handler: async (ctx, { id }) => {
    const userId = await requireAuthedUserId(ctx);
    const outfit = await ctx.db.get(id);
    if (!outfit || outfit.userId !== userId) return null;

    const garments = await Promise.all(
      outfit.garmentIds.map(async (gid) => {
        const item = await ctx.db.get(gid);
        return item
          ? {
              ...item,
              garmentUrl: item.garmentStorageId
                ? await ctx.storage.getUrl(item.garmentStorageId)
                : null,
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
  },
});

// ─── Mutations ──────────────────────────────────────────────────

/** Create an outfit and kick off AI generation. */
export const createOutfit = mutation({
  args: {
    name: v.optional(v.string()),
    garmentIds: v.array(v.id("wardrobeItems")),
    setting: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuthedUserId(ctx);

    // Validate: 2-6 garments, all owned by user
    if (args.garmentIds.length < 2 || args.garmentIds.length > 6) {
      throw new Error("Outfit must have 2–6 garments");
    }
    for (const gid of args.garmentIds) {
      const item = await ctx.db.get(gid);
      if (!item || item.userId !== userId) throw new Error(`Garment ${gid} not found`);
    }

    const name = (args.name || "Untitled Outfit").slice(0, 120);
    const setting = args.setting?.slice(0, 300);

    const outfitId = await ctx.db.insert("outfits", {
      userId,
      name,
      garmentIds: args.garmentIds,
      setting,
      status: "generating",
      tags: [],
    });

    // Schedule AI generation as an internal action
    await ctx.scheduler.runAfter(0, "outfits:generateOutfitImage", {
      outfitId,
    });

    return outfitId;
  },
});

/** Delete an outfit. */
export const deleteOutfit = mutation({
  args: { id: v.id("outfits") },
  handler: async (ctx, { id }) => {
    const userId = await requireAuthedUserId(ctx);
    const outfit = await ctx.db.get(id);
    if (!outfit || outfit.userId !== userId) throw new Error("Not found");
    // Delete image from storage
    if (outfit.imageStorageId) await ctx.storage.delete(outfit.imageStorageId);
    await ctx.db.delete(id);
  },
});

/** Regenerate an outfit's AI image. */
export const regenerateOutfit = mutation({
  args: { id: v.id("outfits") },
  handler: async (ctx, { id }) => {
    const userId = await requireAuthedUserId(ctx);
    const outfit = await ctx.db.get(id);
    if (!outfit || outfit.userId !== userId) throw new Error("Not found");

    // Delete old image
    if (outfit.imageStorageId) await ctx.storage.delete(outfit.imageStorageId);

    // Reset to generating state
    await ctx.db.patch(id, {
      status: "generating",
      imageStorageId: undefined,
      error: undefined,
      description: undefined,
      tags: [],
    });

    // Schedule new generation
    await ctx.scheduler.runAfter(0, "outfits:generateOutfitImage", {
      outfitId: id,
    });
  },
});

// ─── Internal Actions (AI generation) ──────────────────────────

/** Generate outfit image via OpenAI gpt-image-1. */
export const generateOutfitImage = action({
  args: { outfitId: v.id("outfits") },
  handler: async (ctx, { outfitId }) => {
    // Read outfit and garments from DB (actions cannot use ctx.db directly)
    const outfit = await ctx.runQuery("outfits:getOutfitById", { outfitId });
    if (!outfit || outfit.status !== "generating") {
      console.log("Outfit not in generating state, skipping");
      return;
    }

    const userId = outfit.userId;

    try {
      // Fetch all garment items in one shot (preserving order of garmentIds)
      const items = await ctx.runQuery("outfits:getWardrobeItemsByIds", {
        ids: outfit.garmentIds,
      });
      const itemsById = new Map(items.map((it: any) => [it._id, it]));
      const garmentData = await Promise.all(
        outfit.garmentIds.map(async (gid) => {
          const item: any = itemsById.get(gid);
          if (!item) throw new Error(`Garment ${gid} not found`);
          const imageUrl = item.garmentStorageId
            ? await ctx.storage.getUrl(item.garmentStorageId)
            : null;
          return { item, imageUrl };
        })
      );

      // Fetch model reference(s) — for now we'll use the first garment's modeled image
      // TODO: support multiple model references per user
      const modelRefUrl = garmentData.find(
        (g) => g.item.modeledStorageId
      )
        ? await ctx.storage.getUrl(
            garmentData.find((g) => g.item.modeledStorageId)!.item
              .modeledStorageId!
          )
        : null;

      // Build the prompt
      const prompt = buildOutfitPrompt(garmentData.map((g) => g.item));

      // Call OpenAI image edit
      const baseUrl =
        process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1";
      const model =
        process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";

      // Download images as blobs for multipart upload
      const imageParts: { filename: string; data: ArrayBuffer }[] = [];

      // Add model reference as first image
      if (modelRefUrl) {
        const resp = await fetch(modelRefUrl);
        imageParts.push({
          filename: "model.png",
          data: await resp.arrayBuffer(),
        });
      }

      // Add each garment image
      for (let i = 0; i < garmentData.length; i++) {
        const resp = await fetch(garmentData[i].imageUrl!);
        imageParts.push({
          filename: `${garmentData[i].item._id}.png`,
          data: await resp.arrayBuffer(),
        });
      }

      // Build multipart form data
      const formData = new FormData();
      formData.append("model", model);
      formData.append("prompt", prompt);
      formData.append("size", "1024x1024");
      formData.append("quality", process.env.OPENAI_IMAGE_QUALITY || "high");
      formData.append("output_format", "png");
      for (const part of imageParts) {
        formData.append(
          "image[]",
          new Blob([part.data], { type: "image/png" }),
          part.filename
        );
      }

      const response = await fetch(`${baseUrl}/images/edits`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errText = await response.text();
        // Mark outfit as failed
        await ctx.runMutation("outfits:patchOutfit", {
          outfitId,
          status: "failed",
          error: `Image generation failed: ${response.status} ${errText.slice(0, 200)}`,
        });
        return;
      }

      const result = await response.json();
      await safeRecord(ctx, { userId, endpoint: "images/edits", label: "outfit", model, usage: result.usage });
      const imageBase64 = result.data?.[0]?.b64_json;
      if (!imageBase64) {
        await ctx.runMutation("outfits:patchOutfit", {
          outfitId,
          status: "failed",
          error: "No image returned from OpenAI",
        });
        return;
      }

      // Upload image to Convex storage
      const uploadUrl = await ctx.storage.generateUploadUrl();
      const uploadResp = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0)),
      });
      const { storageId } = await uploadResp.json();

      // Update outfit with image
      await ctx.runMutation("outfits:patchOutfit", {
        outfitId,
        imageStorageId: storageId,
      });

      // Run editorial analysis (non-fatal secondary step)
      try {
        const imageUrl = await ctx.storage.getUrl(storageId);
        const analysis = await analyzeOutfitImage(baseUrl, imageUrl!);
        await safeRecord(ctx, { userId, endpoint: "responses", label: "outfit-analyze", model: process.env.OPENAI_VISION_MODEL || "gpt-5.4-mini", usage: analysis._usage });
        await ctx.runMutation("outfits:patchOutfit", {
          outfitId,
          status: "ready",
          description: analysis.description?.slice(0, 300),
          tags: (analysis.tags || []).slice(0, 4).map((t: string) => t.toUpperCase().slice(0, 24)),
        });
      } catch (e) {
        // Analysis failed — still mark as ready, just without description/tags
        console.error("Editorial analysis failed:", e);
        await ctx.runMutation("outfits:patchOutfit", {
          outfitId,
          status: "ready",
        });
      }
    } catch (error: any) {
      console.error("Outfit generation error:", error);
      await ctx.runMutation("outfits:patchOutfit", {
        outfitId,
        status: "failed",
        error: error.message?.slice(0, 300) || "Unknown error",
      });
    }
  },
});

// ─── Helpers ────────────────────────────────────────────────────

function buildOutfitPrompt(items: any[]): string {
  const parts: Record<string, any[]> = {
    tops: [],
    bottoms: [],
    outer: [],
    shoes: [],
    accessories: [],
  };

  for (const item of items) {
    switch (item.part) {
      case "upperbody":
        parts.tops.push(item);
        break;
      case "lowerbody":
        parts.bottoms.push(item);
        break;
      case "wholebody_up":
        parts.outer.push(item);
        break;
      case "shoes":
        parts.shoes.push(item);
        break;
      case "accessories_up":
        parts.accessories.push(item);
        break;
    }
  }

  let prompt = `Use case: identity-preserve / Asset type: square outfit gallery photograph (1024×1024, fashion editorial style, soft studio lighting).

Model identity: The person in the reference photo(s) MUST be preserved exactly — same face, body type, skin tone, and proportions. Do NOT modify their appearance.

`;

  if (parts.tops.length > 0) {
    prompt += `Tops (wear ALL of these as layered pieces):\n`;
    for (const t of parts.tops) {
      prompt += `- "${t.name}" in ${t.color}\n`;
    }
  }
  if (parts.bottoms.length > 0) {
    prompt += `Bottoms:\n`;
    for (const b of parts.bottoms) {
      prompt += `- "${b.name}" in ${b.color}\n`;
    }
  }
  if (parts.outer.length > 0) {
    prompt += `Outerwear (layered-look clause — wear OPEN, never invent zippers/buttons not visible in the source):\n`;
    for (const o of parts.outer) {
      prompt += `- "${o.name}" in ${o.color}\n`;
    }
  }
  if (parts.shoes.length > 0) {
    prompt += `Shoes:\n`;
    for (const s of parts.shoes) {
      prompt += `- "${s.name}" in ${s.color}\n`;
    }
  }
  if (parts.accessories.length > 0) {
    prompt += `Accessories:\n`;
    for (const a of parts.accessories) {
      prompt += `- "${a.name}" in ${a.color}\n`;
    }
  }

  prompt += `\nAVOID: Changing the model's identity, inventing garments not listed, adding logos/brands not in the source, mirror reflections, multiple people, visible image seams or chroma-key artifacts.`;

  return prompt;
}

async function analyzeOutfitImage(
  baseUrl: string,
  imageUrl: string
): Promise<{ description: string; tags: string[]; _usage?: any }> {
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
          { type: "input_text", text: `You are a fashion editor. Look at this outfit photo. Write a one-sentence style note (max 30 words), then provide 2–3 uppercase style tags.` },
          { type: "input_image", image_url: imageUrl, detail: "high" },
        ],
      }],
      text: {
        format: {
          type: "json_schema",
          name: "outfit_metadata",
          schema: {
            type: "object",
            properties: {
              description: { type: "string", maxLength: 300 },
              tags: { type: "array", maxItems: 4, items: { type: "string", maxLength: 24 } },
            },
            required: ["description", "tags"],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!response.ok) throw new Error(`Analysis failed: ${response.status}`);

  const data = await response.json();
  return { ...JSON.parse(data.output[0].content[0].text), _usage: data.usage };
}
