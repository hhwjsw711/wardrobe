import { v } from "convex/values";
import { query, mutation, action, internalQuery, internalMutation } from "./_generated/server";
import { requireAuthedUserId } from "./helpers";
import { deductTryonImpl } from "./credits";

// ─── Internal helpers (for actions, which lack ctx.db) ───────────

/** Internal: read a try-on job by ID. */
export const getTryonJobById = internalQuery({
  args: { jobId: v.id("tryonJobs") },
  handler: async (ctx, { jobId }) => {
    return await ctx.db.get(jobId);
  },
});

/** Internal: read an outfit by ID (used by processTryon action). */
export const getOutfitForTryon = internalQuery({
  args: { outfitId: v.id("outfits") },
  handler: async (ctx, { outfitId }) => {
    return await ctx.db.get(outfitId);
  },
});

/** Internal: patch a try-on job. */
export const patchTryonJob = internalMutation({
  args: {
    jobId: v.id("tryonJobs"),
    status: v.union(v.literal("processing"), v.literal("done"), v.literal("failed")),
    imageStorageId: v.optional(v.id("_storage")),
    completedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { jobId, ...patch }) => {
    await ctx.db.patch(jobId, patch);
  },
});

// ─── Queries ────────────────────────────────────────────────────

/** Get try-on jobs for an outfit. */
export const getTryonJobs = query({
  args: { outfitId: v.id("outfits") },
  handler: async (ctx, { outfitId }) => {
    const userId = await requireAuthedUserId(ctx);
    const jobs = await ctx.db
      .query("tryonJobs")
      .withIndex("by_outfit", (q) => q.eq("outfitId", outfitId))
      .order("desc")
      .collect();
    // Only return user's own jobs. Use Promise.all so the imageUrl
    // lookups actually resolve before serialization (the prior version
    // returned an array of unresolved Promises that JSON-stringified to
    // [{}]).
    const filtered = jobs.filter((j) => j.userId === userId);
    return Promise.all(
      filtered.map(async (j) => ({
        ...j,
        imageUrl: j.imageStorageId
          ? await ctx.storage.getUrl(j.imageStorageId)
          : null,
      }))
    );
  },
});

/** Get a single try-on job result. */
export const getTryonResult = query({
  args: { id: v.id("tryonJobs") },
  handler: async (ctx, { id }) => {
    const userId = await requireAuthedUserId(ctx);
    const job = await ctx.db.get(id);
    if (!job || job.userId !== userId) return null;
    return {
      ...job,
      imageUrl: job.imageStorageId
        ? await ctx.storage.getUrl(job.imageStorageId)
        : null,
    };
  },
});

// ─── Mutations ──────────────────────────────────────────────────

/** Start a try-on job. Deducts 10 credits and schedules AI processing. */
export const startTryon = mutation({
  args: {
    outfitId: v.id("outfits"),
  },
  handler: async (ctx, { outfitId }) => {
    const userId = await requireAuthedUserId(ctx);

    // Validate outfit belongs to user and is ready
    const outfit = await ctx.db.get(outfitId);
    if (!outfit || outfit.userId !== userId) throw new Error("Outfit not found");
    if (outfit.status !== "ready") throw new Error("Outfit not ready for try-on");

    // Create the job first so we have an ID for the ledger `refId`.
    const jobId = await ctx.db.insert("tryonJobs", {
      userId,
      outfitId,
      status: "pending",
    });

    // Deduct 10 credits. Throws if insufficient — roll back the job on
    // failure so we don't leave an orphan "pending" row.
    try {
      await deductTryonImpl(ctx, userId, jobId);
    } catch (err) {
      await ctx.db.delete(jobId);
      throw err;
    }

    // Kick off the actual image generation asynchronously.
    // processTryon runs without user auth (scheduler-invoked actions don't
    // carry sessions), so any DB writes inside it use internal mutations.
    await ctx.scheduler.runAfter(0, "tryon:processTryon", { jobId });

    return { jobId };
  },
});

/** Process a try-on job (called by scheduler after credit deduction). */
export const processTryon = action({
  args: { jobId: v.id("tryonJobs") },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.runQuery("tryon:getTryonJobById", { jobId });
    if (!job || job.status !== "pending") return;

    // Update status
    await ctx.runMutation("tryon:patchTryonJob", { jobId, status: "processing" });

    try {
      // Fetch outfit image
      const outfit = await ctx.runQuery("tryon:getOutfitForTryon", { outfitId: job.outfitId });
      if (!outfit || !outfit.imageStorageId) throw new Error("No outfit image");

      const outfitImageUrl = await ctx.storage.getUrl(outfit.imageStorageId);
      if (!outfitImageUrl) throw new Error("Cannot get outfit image URL");

      // Call OpenAI for try-on generation
      // TODO: Implement actual try-on API call (may need different model/endpoint)
      // For now, this is a placeholder that mirrors the outfit image

      const baseUrl = process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1";
      const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";

      const imageResp = await fetch(outfitImageUrl);
      const imageBlob = await imageResp.blob();

      const formData = new FormData();
      formData.append("model", model);
      formData.append(
        "prompt",
        "Generate a try-on visualization of this outfit worn by the model. Preserve exact garment details and model identity."
      );
      formData.append("size", "1024x1024");
      formData.append("quality", process.env.OPENAI_IMAGE_QUALITY || "high");
      formData.append("output_format", "png");
      formData.append("image[]", imageBlob, "outfit.png");

      const response = await fetch(`${baseUrl}/images/edits`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Try-on generation failed: ${response.status} ${errText.slice(0, 200)}`);
      }

      const result = await response.json();
      const imageBase64 = result.data?.[0]?.b64_json;
      if (!imageBase64) throw new Error("No image returned from OpenAI");

      // Upload to Convex storage
      const uploadUrl = await ctx.storage.generateUploadUrl();
      const uploadResp = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0)),
      });
      const { storageId } = await uploadResp.json();

      await ctx.runMutation("tryon:patchTryonJob", {
        jobId,
        status: "done",
        imageStorageId: storageId,
        completedAt: Date.now(),
      });
    } catch (error: any) {
      // Mark the job as failed first so the user sees the error state.
      await ctx.runMutation("tryon:patchTryonJob", {
        jobId,
        status: "failed",
        error: error.message?.slice(0, 300) || "Unknown error",
      });
      // Refund the 10 credits deducted by startTryon. Uses the internal
      // mutation because scheduler-invoked actions don't carry user auth,
      // so the public refundCredits mutation would throw "Unauthorized".
      try {
        await ctx.runMutation("credits:refundCreditsInternal", {
          userId: job.userId,
          amount: 10,
          reason: "refund",
          refId: jobId,
        });
      } catch (refundErr) {
        // Don't let a refund failure mask the original error.
        console.error("[tryon] refund failed for job", jobId, refundErr);
      }
    }
  },
});
