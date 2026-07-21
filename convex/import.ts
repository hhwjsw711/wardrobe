import { v } from "convex/values";
import { mutation, action, query, internalQuery, internalMutation } from "./_generated/server";
import { requireAuthedUserId, sanitizeColor } from "./helpers";

// ─── Import Pipeline ────────────────────────────────────────────
//
// Multi-stage human-in-the-loop import pipeline:
//
//   Upload → analyzeUpload → crop review → garment generation
//   → garment review (metadata edit) → modeled generation
//   → modeled review → product match → complete
//
// AutoProcess mode: all review stages auto-approve and the pipeline
// runs end-to-end without user intervention.
//
// Tables:
//   importJobs — tracks the pipeline for each detected item
//   modelReferences — user's styling reference photos
//   wardrobeItems — created when garment is approved
// ──────────────────────────────────────────────────────────────────

// ─── Queries ────────────────────────────────────────────────────

/**
 * Internal query: fetch a single import job by its ID.
 * Used by actions (which cannot access ctx.db directly) to read job state.
 */
export const getJobById = internalQuery({
  args: { jobId: v.id("importJobs") },
  handler: async (ctx, { jobId }) => {
    return await ctx.db.get(jobId);
  },
});

/**
 * Internal query: fetch a user's model reference storage IDs.
 * Used by the generateModeled action to read reference photos without
 * going through the auth-checked public query.
 */
export const getModelReferencesForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const refs = await ctx.db
      .query("modelReferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return refs.map((r) => r.storageId);
  },
});

/** Get all active import jobs for the current user (with image URLs resolved). */
export const getImportJobs = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuthedUserId(ctx);
    const jobs = await ctx.db
      .query("importJobs")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    // Filter: only active jobs (not complete, not all stages rejected)
    const active = jobs.filter((job) => {
      if (job.kind === "upload") {
        // Upload jobs are active while analysis is running
        return job.analysis?.status !== "complete" && job.analysis?.status !== "empty";
      }
      // Item jobs are active until all stages are done
      const cropDone = job.stages?.crop?.status === "approved"
        || job.stages?.crop?.status === "rejected";
      const garmentDone = job.stages?.garment?.status === "approved"
        || job.stages?.garment?.status === "rejected";
      const modeledDone = job.stages?.modeled?.status === "approved"
        || job.stages?.modeled?.status === "rejected";
      return !(cropDone && garmentDone && modeledDone);
    });

    // Resolve storage IDs to URLs
    return Promise.all(
      active.map(async (job) => {
        const sourceUrl = job.sourceStorageId
          ? await ctx.storage.getUrl(job.sourceStorageId)
          : null;
        const cropUrl = job.stages?.crop?.storageId
          ? await ctx.storage.getUrl(job.stages.crop.storageId)
          : null;
        const garmentUrl = job.stages?.garment?.storageId
          ? await ctx.storage.getUrl(job.stages.garment.storageId)
          : null;
        const garmentFailedUrl = job.stages?.garment?.failedStorageId
          ? await ctx.storage.getUrl(job.stages.garment.failedStorageId)
          : null;
        const modeledUrl = job.stages?.modeled?.storageId
          ? await ctx.storage.getUrl(job.stages.modeled.storageId)
          : null;

        return {
          id: job._id,
          kind: job.kind,
          originalAssetUrl: sourceUrl,
          metadata: job.metadata,
          analysis: job.analysis,
          stages: {
            crop: job.stages?.crop
              ? { status: job.stages.crop.status, assetUrl: cropUrl, error: job.stages.crop.error }
              : undefined,
            garment: job.stages?.garment
              ? {
                  status: job.stages.garment.status,
                  assetUrl: garmentUrl,
                  error: job.stages.garment.error,
                  failedAssetUrl: garmentFailedUrl,
                }
              : undefined,
            modeled: job.stages?.modeled
              ? { status: job.stages.modeled.status, assetUrl: modeledUrl, error: job.stages.modeled.error }
              : undefined,
          },
          productMatch: job.productMatch,
          wardrobeItemId: job.wardrobeItemId,
          autoProcess: job.autoProcess ?? false,
        };
      })
    );
  },
});

/** Check if the backend is ready for imports (API key + model references). */
export const getSetupStatus = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuthedUserId(ctx);
    const refs = await ctx.db
      .query("modelReferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const hasApiKey = Boolean(process.env.OPENAI_API_KEY);
    return {
      ready: hasApiKey,
      hasApiKey,
      hasModelReference: refs.length > 0,
      modelReferenceCount: refs.length,
      maxModelReferences: 5,
    };
  },
});

/** Get user's model reference photos (with URLs). */
export const getModelReferences = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuthedUserId(ctx);
    const refs = await ctx.db
      .query("modelReferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return Promise.all(
      refs.map(async (ref) => ({
        id: ref._id,
        url: await ctx.storage.getUrl(ref.storageId),
      }))
    );
  },
});

// ─── Mutations ──────────────────────────────────────────────────

/** Start an import: create an upload job and schedule analysis. */
export const startImport = mutation({
  args: {
    sourceStorageId: v.id("_storage"),
    autoProcess: v.optional(v.boolean()),
  },
  handler: async (ctx, { sourceStorageId, autoProcess }) => {
    const userId = await requireAuthedUserId(ctx);
    const jobId = await ctx.db.insert("importJobs", {
      userId,
      kind: "upload",
      sourceStorageId,
      analysis: { status: "queued" },
      autoProcess: autoProcess ?? false,
    });
    // Schedule the analysis action
    await ctx.scheduler.runAfter(0, "import:analyzeUpload", {
      userId,
      jobId,
      sourceStorageId,
      autoProcess: autoProcess ?? false,
    });
    return { jobId, status: "analyzing" };
  },
});

/** Create item jobs after analysis detects clothing items (internal, called by analyzeUpload). */
export const createItemJobs = mutation({
  args: {
    userId: v.id("users"),
    uploadJobId: v.id("importJobs"),
    sourceStorageId: v.id("_storage"),
    items: v.array(v.object({
      name: v.string(),
      part: v.string(),
      color: v.string(),
      secondaryColor: v.optional(v.union(v.string(), v.null())),
      tags: v.optional(v.array(v.string())),
      boundingBox: v.optional(v.object({
        x: v.number(),
        y: v.number(),
        width: v.number(),
        height: v.number(),
      })),
      cropStorageId: v.optional(v.id("_storage")),
    })),
    autoProcess: v.boolean(),
  },
  handler: async (ctx, { userId, uploadJobId, sourceStorageId, items, autoProcess }) => {
    const itemJobIds = [];
    for (const item of items) {
      const initialCropStatus = autoProcess ? "approved" : "review";
      const initialGarmentStatus = autoProcess ? "processing" : "pending";

      const job = {
        userId,
        kind: "item" as const,
        sourceStorageId,
        metadata: {
          name: item.name.slice(0, 120),
          part: item.part,
          color: (sanitizeColor(item.color) ?? "#d8d0c2") as string,
          secondaryColor: sanitizeColor(item.secondaryColor),
          tags: (item.tags || []).slice(0, 4).map((t: string) => t.slice(0, 40).toLowerCase()),
          boundingBox: item.boundingBox || null,
        },
        stages: {
          crop: { status: initialCropStatus, storageId: item.cropStorageId || undefined },
          garment: { status: initialGarmentStatus },
          modeled: { status: "pending" as const },
        },
        autoProcess,
      };

      const jobId = await ctx.db.insert("importJobs", job);
      itemJobIds.push(jobId);

      // If autoProcess, schedule garment generation immediately
      if (autoProcess) {
        await ctx.scheduler.runAfter(0, "import:generateGarment", {
          jobId,
          sourceStorageId,
        });
      }
    }
    return itemJobIds;
  },
});

/** Update metadata on an import job (user edits name/part/color before garment approval). */
export const updateJobMetadata = mutation({
  args: {
    jobId: v.id("importJobs"),
    metadata: v.object({
      name: v.optional(v.string()),
      part: v.optional(v.string()),
      color: v.optional(v.string()),
      secondaryColor: v.optional(v.union(v.string(), v.null())),
      tags: v.optional(v.array(v.string())),
    }),
  },
  handler: async (ctx, { jobId, metadata }) => {
    const userId = await requireAuthedUserId(ctx);
    const job = await ctx.db.get(jobId);
    if (!job || job.userId !== userId) throw new Error("Not found");

    const updatedMetadata = { ...(job.metadata || {}) };
    if (metadata.name !== undefined) updatedMetadata.name = metadata.name.slice(0, 120);
    if (metadata.part !== undefined) updatedMetadata.part = metadata.part;
    if (metadata.color !== undefined) updatedMetadata.color = (sanitizeColor(metadata.color) ?? "#d8d0c2") as string;
    if (metadata.secondaryColor !== undefined) {
      updatedMetadata.secondaryColor = sanitizeColor(metadata.secondaryColor);
    }
    if (metadata.tags !== undefined) {
      updatedMetadata.tags = metadata.tags.slice(0, 12).map((t) => t.slice(0, 40).toLowerCase());
    }

    await ctx.db.patch(jobId, { metadata: updatedMetadata });
  },
});

/** Approve a stage and transition to the next step. */
export const approveStage = mutation({
  args: {
    jobId: v.id("importJobs"),
    stage: v.union(v.literal("crop"), v.literal("garment"), v.literal("modeled")),
  },
  handler: async (ctx, { jobId, stage }) => {
    const userId = await requireAuthedUserId(ctx);
    const job = await ctx.db.get(jobId);
    if (!job || job.userId !== userId) throw new Error("Not found");

    const stages = job.stages || { crop: {}, garment: {}, modeled: {} };

    if (stage === "crop") {
      // Approve crop → start garment generation
      stages.crop = { ...stages.crop, status: "approved" };
      stages.garment = { ...stages.garment, status: "processing" };
      await ctx.db.patch(jobId, { stages });
      await ctx.scheduler.runAfter(0, "import:generateGarment", {
        jobId,
        sourceStorageId: job.sourceStorageId!,
      });
    } else if (stage === "garment") {
      // Approve garment → create wardrobe item + start modeled generation
      stages.garment = { ...stages.garment, status: "approved" };
      stages.modeled = { ...stages.modeled, status: "processing" };
      await ctx.db.patch(jobId, { stages });

      // Create the wardrobe item from the job's metadata + garment image
      const meta = job.metadata || {};
      const wardrobeItemId = await ctx.db.insert("wardrobeItems", {
        userId,
        name: meta.name || "New piece",
        part: meta.part as any || "upperbody",
        color: (sanitizeColor(meta.color) ?? "#d8d0c2") as string,
        secondaryColor: sanitizeColor(meta.secondaryColor),
        tags: meta.tags || [],
        garmentStorageId: stages.garment.storageId,
        sourceStorageId: job.sourceStorageId,
        importJobId: jobId.toString(),
        brand: meta.brand,
        productName: meta.productName,
        productUrl: meta.productUrl,
        productConfidence: meta.productConfidence as any,
      });
      await ctx.db.patch(jobId, { wardrobeItemId });

      // Schedule modeled photo generation
      await ctx.scheduler.runAfter(0, "import:generateModeled", {
        jobId,
        garmentStorageId: stages.garment.storageId!,
      });
    } else if (stage === "modeled") {
      // Approve modeled → update wardrobe item + schedule product match
      stages.modeled = { ...stages.modeled, status: "approved" };
      await ctx.db.patch(jobId, { stages });

      // Update the wardrobe item with the modeled image
      if (job.wardrobeItemId) {
        await ctx.db.patch(job.wardrobeItemId, {
          modeledStorageId: stages.modeled.storageId,
        });
      }

      // Schedule product match
      await ctx.scheduler.runAfter(0, "import:runProductMatch", {
        jobId,
      });
    }
  },
});

/** Reject a stage. For crop/garment, the import job is effectively abandoned. */
export const rejectStage = mutation({
  args: {
    jobId: v.id("importJobs"),
    stage: v.union(v.literal("crop"), v.literal("garment"), v.literal("modeled")),
  },
  handler: async (ctx, { jobId, stage }) => {
    const userId = await requireAuthedUserId(ctx);
    const job = await ctx.db.get(jobId);
    if (!job || job.userId !== userId) throw new Error("Not found");

    const stages = job.stages || { crop: {}, garment: {}, modeled: {} };
    stages[stage] = { ...stages[stage], status: "rejected" };
    await ctx.db.patch(jobId, { stages });

    // If garment was already approved (wardrobe item exists) and modeled is rejected,
    // the wardrobe item stays (it's still usable without a modeled image).
  },
});

/** Delete an import job and its associated stored images. */
export const deleteJob = mutation({
  args: { jobId: v.id("importJobs") },
  handler: async (ctx, { jobId }) => {
    const userId = await requireAuthedUserId(ctx);
    const job = await ctx.db.get(jobId);
    if (!job || job.userId !== userId) throw new Error("Not found");

    // Clean up stored images (but NOT sourceStorageId — might be shared)
    const stages = job.stages || {};
    if (stages.crop?.storageId) await ctx.storage.delete(stages.crop.storageId);
    if (stages.garment?.storageId) await ctx.storage.delete(stages.garment.storageId);
    if (stages.garment?.failedStorageId) await ctx.storage.delete(stages.garment.failedStorageId);
    if (stages.modeled?.storageId) await ctx.storage.delete(stages.modeled.storageId);

    await ctx.db.delete(jobId);
  },
});

/** Save a model reference photo. */
export const saveModelReference = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const userId = await requireAuthedUserId(ctx);
    // Check limit
    const refs = await ctx.db
      .query("modelReferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    if (refs.length >= 5) throw new Error("Maximum 5 styling reference photos");
    await ctx.db.insert("modelReferences", { userId, storageId });
  },
});

/** Delete a model reference photo. */
export const deleteModelReference = mutation({
  args: { refId: v.id("modelReferences") },
  handler: async (ctx, { refId }) => {
    const userId = await requireAuthedUserId(ctx);
    const ref = await ctx.db.get(refId);
    if (!ref || ref.userId !== userId) throw new Error("Not found");
    await ctx.storage.delete(ref.storageId);
    await ctx.db.delete(refId);
  },
});

// ─── Actions ────────────────────────────────────────────────────

/** Analyze an uploaded photo and detect clothing items. */
export const analyzeUpload = action({
  args: {
    userId: v.id("users"),
    jobId: v.id("importJobs"),
    sourceStorageId: v.id("_storage"),
    autoProcess: v.boolean(),
  },
  handler: async (ctx, { userId, jobId, sourceStorageId, autoProcess }) => {
    // Update the upload job status to "processing"
    await ctx.runMutation("import:updateUploadJobAnalysis", {
      jobId,
      status: "processing",
    });

    const imageUrl = await ctx.storage.getUrl(sourceStorageId);
    if (!imageUrl) throw new Error("Source image not found");

    const baseUrl = process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1";
    const visionModel = process.env.OPENAI_VISION_MODEL || "gpt-5.4-mini";

    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: visionModel,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: `Identify every distinct wearable clothing item visible in this image. A photo may show one isolated garment or a person wearing several items. Return one record per actual item that should enter a wardrobe. Ignore the person's body and non-wearable background objects. For each item, include a tight bounding box around only that item using integer coordinates normalized to a 1000 by 1000 image: x and y are the top-left corner, followed by width and height. Boxes may overlap when garments overlap, but each box must focus on one distinct item. Use only these category ids: upperbody, wholebody_up, lowerbody, accessories_up, shoes. Suggest a concise specific name, primary hex color, optional genuinely distinct secondary hex color, and 1-4 useful lowercase detail tags.` },
            { type: "input_image", image_url: imageUrl, detail: "high" },
          ],
        }],
        text: {
          format: {
            type: "json_schema",
            name: "wardrobe_items",
            strict: true,
            schema: {
              type: "object",
              properties: {
                items: {
                  type: "array",
                  minItems: 0,
                  maxItems: 8,
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      part: {
                        type: "string",
                        enum: ["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"],
                      },
                      color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
                      secondaryColor: { anyOf: [{ type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, { type: "null" }] },
                      tags: { type: "array", items: { type: "string" }, maxItems: 4 },
                      boundingBox: {
                        type: "object",
                        properties: {
                          x: { type: "integer", minimum: 0, maximum: 999 },
                          y: { type: "integer", minimum: 0, maximum: 999 },
                          width: { type: "integer", minimum: 1, maximum: 1000 },
                          height: { type: "integer", minimum: 1, maximum: 1000 },
                        },
                        required: ["x", "y", "width", "height"],
                        additionalProperties: false,
                      },
                    },
                    required: ["name", "part", "color", "secondaryColor", "tags", "boundingBox"],
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
      const errText = await response.text();
      console.error(`analyzeUpload failed for ${jobId} (${response.status}):`, errText);
      await ctx.runMutation("import:updateUploadJobAnalysis", {
        jobId,
        status: "failed",
        error: `OpenAI analyze failed: ${response.status} - ${errText.substring(0, 300)}`,
      });
      return;
    }

    const data = await response.json();
    let parsed;
    try {
      parsed = JSON.parse(data.output[0].content[0].text);
    } catch {
      await ctx.runMutation("import:updateUploadJobAnalysis", {
        jobId,
        status: "failed",
        error: "Could not parse analysis results",
      });
      return;
    }

    if (!parsed.items || parsed.items.length === 0) {
      await ctx.runMutation("import:updateUploadJobAnalysis", {
        jobId,
        status: "empty",
      });
      return;
    }

    // Generate per-item crops using sharp (via imageActions)
    const itemsWithCrops: Array<{
      name: string;
      part: string;
      color: string;
      secondaryColor?: string | null;
      tags?: string[];
      boundingBox: { x: number; y: number; width: number; height: number };
      cropStorageId: string;
    }> = [];

    for (const item of parsed.items) {
      const box = item.boundingBox || { x: 0, y: 0, width: 1000, height: 1000 };
      // Normalize bounding box to 0-999/1-1000 range
      const bx = Math.max(0, Math.min(999, Math.round(Number(box.x) || 0)));
      const by = Math.max(0, Math.min(999, Math.round(Number(box.y) || 0)));
      const bw = Math.max(1, Math.min(1000 - bx, Math.round(Number(box.width) || (1000 - bx))));
      const bh = Math.max(1, Math.min(1000 - by, Math.round(Number(box.height) || (1000 - by))));

      // Crop using the imageActions helper (Node.js runtime + sharp)
      const cropStorageId = await ctx.runAction("imageActions:cropDetectedItem", {
        sourceStorageId,
        boundingBox: { x: bx, y: by, width: bw, height: bh },
      });

      itemsWithCrops.push({
        name: item.name,
        part: item.part,
        color: item.color,
        secondaryColor: item.secondaryColor,
        tags: item.tags,
        boundingBox: { x: bx, y: by, width: bw, height: bh },
        cropStorageId: cropStorageId as string,
      });
    }

    // Create item jobs for each detected item (now with crop storage IDs)
    const itemJobIds = await ctx.runMutation("import:createItemJobs", {
      userId,
      uploadJobId: jobId,
      sourceStorageId,
      items: itemsWithCrops,
      autoProcess,
    });

    // Mark the upload job as complete (its purpose was to trigger analysis)
    await ctx.runMutation("import:updateUploadJobAnalysis", {
      jobId,
      status: "complete",
    });

    return { detectedItems: parsed.items.length, itemJobIds };
  },
});

/** Internal mutation: update the analysis status on an upload job. */
export const updateUploadJobAnalysis = mutation({
  args: {
    jobId: v.id("importJobs"),
    status: v.union(
      v.literal("queued"),
      v.literal("processing"),
      v.literal("complete"),
      v.literal("failed"),
      v.literal("empty"),
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { jobId, status, error }) => {
    await ctx.db.patch(jobId, {
      analysis: { status, error },
    });
  },
});

/** Generate a garment cutout from the source photo. */
export const generateGarment = action({
  args: {
    jobId: v.id("importJobs"),
    sourceStorageId: v.id("_storage"),
    regeneratePrompt: v.optional(v.string()),
  },
  handler: async (ctx, { jobId, sourceStorageId, regeneratePrompt }) => {
    const job = await ctx.runQuery("import:getJobById", { jobId });
    if (!job) throw new Error("Import job not found");

    const meta = job.metadata || {};
    const stages = job.stages || { crop: {}, garment: {}, modeled: {} };

    // Use the crop image (per-item cropped region) if available, otherwise fall back to source
    const cropStorageId = stages.crop?.storageId;
    const inputStorageId = cropStorageId || sourceStorageId;
    const inputUrl = await ctx.storage.getUrl(inputStorageId as any);
    if (!inputUrl) throw new Error("Input image not found");

    const baseUrl = process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1";
    const imageModel = process.env.OPENAI_GARMENT_MODEL || process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";

    // Choose chroma key far from garment color
    const chromaKey = chooseChromaKey(meta.color || "#d8d0c2");

    // Build detailed garment prompt matching original app's quality
    const name = meta.name || "clothing item";
    const category = meta.part || "wardrobe item";
    const primary = meta.color || "the exact visible color";
    const secondary = meta.secondaryColor ? ` with distinct secondary color ${meta.secondaryColor}` : "";
    const details = Array.isArray(meta.tags) && meta.tags.length
      ? meta.tags.join(", ")
      : "all visible construction and design details";

    const basePrompt = `Use case: background-extraction
Asset type: ecommerce catalog product cutout source

Input image: The reference photograph shows the exact garment, either by itself or worn by a person. Use it only to identify and reconstruct the garment.

Primary request: Reconstruct ONLY the complete empty ${name} (${category}) as a clean, front-facing ecommerce catalog product photograph. If a wearer is present, remove them. Remove every other garment, object, and background element. Show the complete item naturally arranged and symmetrical, with no person, body, mannequin, or hanger visible.

Garment fidelity: Preserve the reference garment's exact primary color ${primary}${secondary}, material and texture, silhouette, neckline, sleeves, fastenings, pattern, and distinctive details (${details}). Preserve any clearly legible existing graphic or logo exactly, but do not invent or reinterpret uncertain logos, text, pockets, seams, hardware, colors, or decoration.

Composition: Centered straight-on product view. Keep the entire garment inside the frame with generous, even padding on every side. No cropping or truncation.

Background: Perfectly flat, absolutely uniform solid ${chromaKey} chroma-key color, edge-to-edge. No shadows, gradient, texture, vignette, floor, horizon, reflection, or lighting variation.

Lighting: Neutral diffuse product lighting contained on the garment only.

Avoid: person, body, skin, hair, mannequin, hanger, props, other garments, retail tags, cast shadow, contact shadow, reflection, watermark, caption, border, background variation, or chroma spill.

Critical: Use no ${chromaKey} anywhere in the garment. Produce exactly one complete garment with a crisp, separable outer silhouette.`;

    const prompt = regeneratePrompt
      ? `${basePrompt}\nUser regeneration direction: ${regeneratePrompt}`
      : basePrompt;

    // Download input image
    const imageResp = await fetch(inputUrl);
    const imageBlob = await imageResp.blob();

    const formData = new FormData();
    formData.append("model", imageModel);
    formData.append("prompt", prompt);
    formData.append("size", "1024x1024");
    formData.append("quality", process.env.OPENAI_IMAGE_QUALITY || "high");
    formData.append("output_format", "png");
    formData.append("image[]", imageBlob, "source.png");

    const response = await fetch(`${baseUrl}/images/edits`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Garment cutout failed for ${jobId} (${response.status}):`, errText);
      // Update job with failed status
      await ctx.runMutation("import:updateStageStatus", {
        jobId,
        stage: "garment",
        status: "failed",
        error: `Image generation failed: ${response.status} - ${errText.substring(0, 300)}`,
      });
      return;
    }

    const result = await response.json();
    const imageBase64 = result.data?.[0]?.b64_json;
    if (!imageBase64) {
      await ctx.runMutation("import:updateStageStatus", {
        jobId,
        stage: "garment",
        status: "failed",
        error: "No image data in response",
      });
      return;
    }

    // Remove chroma key background + frame garment (delegated to Node.js runtime)
    const { garmentStorageId, failedStorageId: rawFailedStorageId } = await ctx.runAction(
      "imageActions:processGarmentImage",
      { imageBase64, chromaKey },
    );

    if (job.autoProcess) {
      // Auto-approve: update stage, create wardrobe item, schedule modeled
      await ctx.runMutation("import:autoApproveGarment", {
        jobId,
        garmentStorageId,
      });
    } else {
      // Review mode: set garment status to "review"
      await ctx.runMutation("import:updateStageStatus", {
        jobId,
        stage: "garment",
        status: "review",
        storageId: garmentStorageId,
        failedStorageId: rawFailedStorageId,
      });
    }
  },
});

/** Generate a modeled photo of the person wearing the garment. */
export const generateModeled = action({
  args: {
    jobId: v.id("importJobs"),
    garmentStorageId: v.id("_storage"),
    regeneratePrompt: v.optional(v.string()),
  },
  handler: async (ctx, { jobId, garmentStorageId, regeneratePrompt }) => {
    const job = await ctx.runQuery("import:getJobById", { jobId });
    if (!job) throw new Error("Import job not found");

    const garmentUrl = await ctx.storage.getUrl(garmentStorageId);
    if (!garmentUrl) throw new Error("Garment image not found");

    // Get user's model reference photos (storage IDs only)
    const userId = job.userId;
    const modelRefIds = await ctx.runQuery("import:getModelReferencesForUser", { userId });

    const baseUrl = process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1";
    const imageModel = process.env.OPENAI_MODELED_MODEL || process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";

    const basePrompt = "Create a professional horizontal 3:2 editorial fashion photograph of the person in Image 1 wearing the exact garment from Image 2. Preserve the person's recognizable identity, face, hair, age and proportions. Preserve every garment color, material, fit, construction, graphic, logo and distinctive detail. Keep the complete featured item clearly visible and unobstructed, use understated neutral supporting clothes, realistic anatomy, natural light, authentic fabric, a tasteful real-world setting, and leave environmental space around the model. No text, watermark, product mockup, or synthetic appearance.";

    const prompt = regeneratePrompt
      ? `${basePrompt}\nUser regeneration direction: ${regeneratePrompt}`
      : basePrompt;

    // Build multipart with model refs + garment
    const formData = new FormData();
    formData.append("model", imageModel);
    formData.append("prompt", prompt);
    formData.append("size", "1536x1024");
    formData.append("quality", process.env.OPENAI_IMAGE_QUALITY || "high");
    formData.append("output_format", "png");

    // Add model reference images
    for (let i = 0; i < modelRefIds.length; i++) {
      const refUrl = await ctx.storage.getUrl(modelRefIds[i]);
      if (refUrl) {
        const resp = await fetch(refUrl);
        formData.append("image[]", await resp.blob(), `ref${i}.png`);
      }
    }

    // Add the garment image
    const garmentResp = await fetch(garmentUrl);
    formData.append("image[]", await garmentResp.blob(), "garment.png");

    const response = await fetch(`${baseUrl}/images/edits`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Modeled photo failed for ${jobId} (${response.status}):`, errText);
      await ctx.runMutation("import:updateStageStatus", {
        jobId,
        stage: "modeled",
        status: "failed",
        error: `Image generation failed: ${response.status} - ${errText.substring(0, 300)}`,
      });
      return;
    }

    const result = await response.json();
    const imageBase64 = result.data?.[0]?.b64_json;
    if (!imageBase64) {
      await ctx.runMutation("import:updateStageStatus", {
        jobId,
        stage: "modeled",
        status: "failed",
        error: "No image data in response",
      });
      return;
    }

    // Upload to Convex storage
    const uploadUrl = await ctx.storage.generateUploadUrl();
    const uploadResp = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0)),
    });
    const { storageId: modeledStorageId } = await uploadResp.json();

    if (job.autoProcess) {
      // Auto-approve: update stage, update wardrobe item, schedule product match
      await ctx.runMutation("import:autoApproveModeled", {
        jobId,
        modeledStorageId,
      });
    } else {
      // Review mode: set modeled status to "review"
      await ctx.runMutation("import:updateStageStatus", {
        jobId,
        stage: "modeled",
        status: "review",
        storageId: modeledStorageId,
      });
    }
  },
});

/** Regenerate a stage image with an optional prompt. */
export const regenerateStage = action({
  args: {
    jobId: v.id("importJobs"),
    stage: v.union(v.literal("garment"), v.literal("modeled")),
    prompt: v.optional(v.string()),
  },
  handler: async (ctx, { jobId, stage, prompt }) => {
    const job = await ctx.runQuery("import:getJobById", { jobId });
    if (!job) throw new Error("Import job not found");

    // Set stage status back to processing
    await ctx.runMutation("import:updateStageStatus", {
      jobId,
      stage,
      status: "processing",
    });

    if (stage === "garment") {
      await ctx.scheduler.runAfter(0, "import:generateGarment", {
        jobId,
        sourceStorageId: job.sourceStorageId!,
        regeneratePrompt: prompt || "",
      });
    } else if (stage === "modeled") {
      const garmentStorageId = job.stages?.garment?.storageId;
      if (!garmentStorageId) throw new Error("No garment image to base modeled photo on");
      await ctx.scheduler.runAfter(0, "import:generateModeled", {
        jobId,
        garmentStorageId,
        regeneratePrompt: prompt || "",
      });
    }
  },
});

/** Retry a failed analysis on an upload job. */
export const retryAnalysis = action({
  args: {
    jobId: v.id("importJobs"),
  },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.runQuery("import:getJobById", { jobId });
    if (!job) throw new Error("Import job not found");
    if (job.kind !== "upload") throw new Error("Can only retry analysis on upload jobs");

    // Reset analysis status and re-schedule
    await ctx.runMutation("import:updateUploadJobAnalysis", {
      jobId,
      status: "queued",
    });

    await ctx.scheduler.runAfter(0, "import:analyzeUpload", {
      userId: job.userId,
      jobId,
      sourceStorageId: job.sourceStorageId!,
      autoProcess: job.autoProcess ?? false,
    });
  },
});

/** Run product match on a completed import job's garment. */
export const runProductMatch = action({
  args: {
    jobId: v.id("importJobs"),
  },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.runQuery("import:getJobById", { jobId });
    if (!job) throw new Error("Import job not found");

    const garmentStorageId = job.stages?.garment?.storageId;
    if (!garmentStorageId) return;

    // Update productMatch status
    await ctx.runMutation("import:updateProductMatchStatus", {
      jobId,
      status: "processing",
    });

    const imageUrl = await ctx.storage.getUrl(garmentStorageId);
    if (!imageUrl) return;

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
        tools: [{ type: "web_search", search_context_size: "medium" }],
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
      const errText = await response.text();
      console.error(`Product match failed for ${jobId} (${response.status}):`, errText);
      await ctx.runMutation("import:updateProductMatchStatus", {
        jobId,
        status: "failed",
      });
      return;
    }

    const data = await response.json();

    // The Responses API with the web_search tool returns output items in order:
    // web_search_call(s) first, then the final assistant message. Find the
    // message item rather than hardcoding output[0] (which would be the search call).
    const messageItem = data.output?.find((item: any) => item.type === "message");
    const contentItem = messageItem?.content?.find((c: any) => c.type === "output_text")
      || messageItem?.content?.[0];
    if (!contentItem?.text) {
      console.error(`Product match returned no message text for ${jobId}`);
      await ctx.runMutation("import:updateProductMatchStatus", {
        jobId,
        status: "failed",
      });
      return;
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

    // Downgrade exact → likely if missing key fields
    let confidence = parsed.confidence;
    if (confidence === "exact" && (!parsed.brand || !parsed.productName || !parsed.sourceUrl)) {
      confidence = "likely";
    }

    // Update the import job metadata. Note: productColorway is NOT a field in
    // the importJobs.metadata schema, so it is only stored on the wardrobe item.
    await ctx.runMutation("import:patchJobProductMetadata", {
      jobId,
      brand: parsed.brand ?? null,
      productName: parsed.productName ?? null,
      productUrl: parsed.sourceUrl ?? null,
      productConfidence: confidence,
    });

    // Update wardrobe item if it exists
    if (job.wardrobeItemId) {
      await ctx.runMutation("wardrobe:patchItemProductMatch", {
        itemId: job.wardrobeItemId,
        brand: parsed.brand ?? null,
        productName: parsed.productName ?? null,
        productColorway: parsed.colorway ?? null,
        productUrl: parsed.sourceUrl ?? null,
        productConfidence: confidence,
        productEvidence: parsed.identifyingFeatures?.slice(0, 6) || [],
        productSources: sources.slice(0, 8),
        productMatchSummary: parsed.summary?.slice(0, 500) || "",
      });
    }

    await ctx.runMutation("import:updateProductMatchStatus", {
      jobId,
      status: "complete",
    });
  },
});

// ─── Internal Mutations (called by actions) ──────────────────────

/** Update a stage's status (and optionally its storageId). */
export const updateStageStatus = mutation({
  args: {
    jobId: v.id("importJobs"),
    stage: v.union(v.literal("crop"), v.literal("garment"), v.literal("modeled")),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("review"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("failed"),
    ),
    storageId: v.optional(v.id("_storage")),
    failedStorageId: v.optional(v.id("_storage")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { jobId, stage, status, storageId, failedStorageId, error }) => {
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Not found");
    const stages = job.stages || { crop: {}, garment: {}, modeled: {} };
    const updated = { ...stages[stage], status };
    if (storageId !== undefined) updated.storageId = storageId;
    if (failedStorageId !== undefined) updated.failedStorageId = failedStorageId;
    if (error !== undefined) updated.error = error;
    stages[stage] = updated;
    await ctx.db.patch(jobId, { stages });
  },
});

/** Auto-approve garment: create wardrobe item + schedule modeled. */
export const autoApproveGarment = mutation({
  args: {
    jobId: v.id("importJobs"),
    garmentStorageId: v.id("_storage"),
  },
  handler: async (ctx, { jobId, garmentStorageId }) => {
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Not found");

    const stages = job.stages || { crop: {}, garment: {}, modeled: {} };
    stages.garment = { ...stages.garment, status: "approved", storageId: garmentStorageId };
    stages.modeled = { ...stages.modeled, status: "processing" };
    await ctx.db.patch(jobId, { stages });

    // Create wardrobe item
    const meta = job.metadata || {};
    const wardrobeItemId = await ctx.db.insert("wardrobeItems", {
      userId: job.userId,
      name: meta.name || "New piece",
      part: meta.part as any || "upperbody",
      color: (sanitizeColor(meta.color) ?? "#d8d0c2") as string,
      secondaryColor: sanitizeColor(meta.secondaryColor),
      tags: meta.tags || [],
      garmentStorageId,
      sourceStorageId: job.sourceStorageId,
      importJobId: jobId.toString(),
      brand: meta.brand,
      productName: meta.productName,
      productUrl: meta.productUrl,
      productConfidence: meta.productConfidence as any,
    });
    await ctx.db.patch(jobId, { wardrobeItemId });

    // Schedule modeled photo generation
    await ctx.scheduler.runAfter(0, "import:generateModeled", {
      jobId,
      garmentStorageId,
    });
  },
});

/** Auto-approve modeled: update wardrobe item + schedule product match. */
export const autoApproveModeled = mutation({
  args: {
    jobId: v.id("importJobs"),
    modeledStorageId: v.id("_storage"),
  },
  handler: async (ctx, { jobId, modeledStorageId }) => {
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Not found");

    const stages = job.stages || { crop: {}, garment: {}, modeled: {} };
    stages.modeled = { ...stages.modeled, status: "approved", storageId: modeledStorageId };
    await ctx.db.patch(jobId, { stages });

    // Update wardrobe item
    if (job.wardrobeItemId) {
      await ctx.db.patch(job.wardrobeItemId, {
        modeledStorageId,
      });
    }

    // Schedule product match
    await ctx.scheduler.runAfter(0, "import:runProductMatch", {
      jobId,
    });
  },
});

/** Update productMatch status on an import job. */
export const updateProductMatchStatus = mutation({
  args: {
    jobId: v.id("importJobs"),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("complete"),
      v.literal("failed"),
    ),
  },
  handler: async (ctx, { jobId, status }) => {
    await ctx.db.patch(jobId, { productMatch: { status } });
  },
});

/** Patch product match fields onto an import job's metadata (called by actions). */
export const patchJobProductMetadata = internalMutation({
  args: {
    jobId: v.id("importJobs"),
    brand: v.union(v.string(), v.null()),
    productName: v.union(v.string(), v.null()),
    productUrl: v.union(v.string(), v.null()),
    productConfidence: v.string(),
  },
  handler: async (ctx, { jobId, brand, productName, productUrl, productConfidence }) => {
    const job = await ctx.db.get(jobId);
    if (!job?.metadata) return;
    await ctx.db.patch(jobId, {
      metadata: {
        ...job.metadata,
        productConfidence,
        ...(brand ? { brand } : {}),
        ...(productName ? { productName } : {}),
        ...(productUrl ? { productUrl } : {}),
      },
    });
  },
});

// ─── Helpers ────────────────────────────────────────────────────

/** Choose a chroma key color far from the garment's primary color. */
function chooseChromaKey(primaryColor: string): string {
  const r = parseInt(primaryColor.slice(1, 3), 16);
  const g = parseInt(primaryColor.slice(3, 5), 16);
  const b = parseInt(primaryColor.slice(5, 7), 16);

  const options = [
    { name: "#00ff00", r: 0, g: 255, b: 0 },
    { name: "#ff00ff", r: 255, g: 0, b: 255 },
    { name: "#00ffff", r: 0, g: 255, b: 255 },
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
