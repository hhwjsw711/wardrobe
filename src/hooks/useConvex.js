/**
 * Convex-backed hooks for the Wardrobe app.
 *
 * These hooks replace the Vite-plugin fetch() calls in App.jsx
 * with Convex real-time queries and mutations.
 *
 * Design: map Convex data shapes to match what App.jsx expects
 * (_id → id, garmentUrl → image, etc.), so component logic stays unchanged.
 */
import { useQuery, useMutation, useAction } from "convex/react";
import { useMemo } from "react";
import { api } from "../../convex/_generated/api";

// Module-level constants so loading-state placeholders keep a stable
// reference across renders. Without this, `rawData ?? []` creates a
// fresh array every render, which makes downstream useEffect hooks
// that depend on the array fire endlessly (Maximum update depth
// exceeded).
const EMPTY_ARRAY = [];
const EMPTY_IMPORT_JOBS = EMPTY_ARRAY;
const EMPTY_MODEL_REFS = EMPTY_ARRAY;

// ─── Data Shape Mappers ──────────────────────────────────────────

/**
 * Map a Convex wardrobe item to the shape App.jsx expects.
 *
 * Convex returns: { _id, garmentUrl, modeledUrl, sourceUrl, ... }
 * App.jsx expects: { id, image, thumbnail, modeledImage, palette, ... }
 */
/**
 * Normalize color values returned by the AI vision pipeline. The OpenAI
 * analysis schema allows `secondaryColor` to be null, but in practice the
 * model occasionally emits the string "null" (or "none"/"undefined"/""),
 * which then flows through the schema (`v.union(v.string(), v.null())`)
 * as a string and leaks straight into the UI — showing "null" in the
 * Selected swatch label and triggering console warnings about
 * `backgroundColor: "null"` not conforming to #rrggbb.
 *
 * Returns the lowercased hex string when the value is a plausible color,
 * otherwise null. Used both on `item.color` / `item.secondaryColor` and
 * on every entry of `palette` so the ColorControl never renders an
 * unusable swatch.
 */
function sanitizeColor(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v || v === "null" || v === "undefined" || v === "none") return null;
  return v;
}

function mapWardrobeItem(item) {
  return {
    id: item._id,
    importJobId: item.importJobId || null,
    name: item.name,
    part: item.part,
    color: sanitizeColor(item.color) || "#9a9286",
    secondaryColor: sanitizeColor(item.secondaryColor),
    tags: item.tags || [],
    image: item.garmentUrl || item.sourceUrl || "",
    thumbnail: item.garmentUrl || item.sourceUrl || "",
    modeledImage: item.modeledUrl || null,
    palette: [sanitizeColor(item.color), sanitizeColor(item.secondaryColor)].filter(Boolean),
    brand: item.brand || null,
    productName: item.productName || null,
    productColorway: item.productColorway || null,
    productUrl: item.productUrl || null,
    productConfidence: item.productConfidence || null,
    productEvidence: item.productEvidence || [],
    productSources: item.productSources || [],
    productMatchSummary: item.productMatchSummary || null,
  };
}

/**
 * Map a Convex outfit to the shape App.jsx expects.
 *
 * Convex returns: { _id, imageUrl, garments: [...enriched items], ... }
 * App.jsx expects: { id, image, garments: [...mapped items], createdAt, ... }
 */
function mapOutfit(outfit) {
  return {
    id: outfit._id,
    name: outfit.name,
    status: outfit.status,
    image: outfit.imageUrl || null,
    garments: (outfit.garments || []).map(mapWardrobeItem),
    description: outfit.description || null,
    tags: outfit.tags || [],
    setting: outfit.setting || null,
    createdAt: new Date(outfit._creationTime).toISOString(),
    error: outfit.error || null,
  };
}

/**
 * Map a Convex try-on job to the shape App.jsx expects, and normalize
 * any pre-sanitizer error messages so legacy jobs show the same friendly
 * text as new ones. Newer backend messages are already friendly — they
 * pass through unchanged; only raw API JSON gets scrubbed here.
 */
function mapTryonJob(job) {
  return {
    id: job._id,
    outfitId: job.outfitId,
    status: job.status,
    imageUrl: job.imageUrl || null,
    error: sanitizeTryonError(job.error || null),
    createdAt: new Date(job._creationTime).toISOString(),
    completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null,
  };
}

/**
 * Frontend mirror of convex/tryon.ts::friendlyTryonError. Treats errors
 * already produced by the friendly backend as no-ops, and converts any
 * historical raw OpenAI JSON into a short user-facing string. This means
 * jobs that failed before the backend sanitizer shipped still render
 * cleanly without requiring a data migration.
 */
function sanitizeTryonError(raw) {
  if (!raw) return null;
  if (typeof raw !== "string") return "Try-on generation failed. Please try again later.";
  const friendly = raw.trim();
  // Already-friendly messages pass straight through (no JSON braces, no
  // HTTP status prefix). Avoids re-wrapping the new backend output.
  if (!friendly.includes("{") && !/^try-on generation failed: \d/.test(friendly.toLowerCase())) {
    return friendly;
  }
  const lower = friendly.toLowerCase();
  if (lower.includes("billing") && lower.includes("limit")) {
    return "Try-on service is temporarily unavailable. Please try again later.";
  }
  if (lower.includes("rate limit") || lower.includes("quota")) {
    return "Too many try-on requests. Please wait a moment and try again.";
  }
  if (lower.includes("no outfit image")) return "Outfit image is not ready yet.";
  if (lower.includes("cannot get outfit image url")) return "Could not load the outfit image. Please try again.";
  if (lower.includes("no image returned")) return "Try-on service returned no image. Please try again.";
  return "Try-on generation failed. Please try again later.";
}

// ─── Wardrobe ────────────────────────────────────────────────────

/**
 * Hook that replaces: GET /api/import/wardrobe + PATCH/DELETE + product-match
 *
 * Returns:
 *   items: WardrobeItem[] (real-time, no polling)
 *   loading: boolean
 *   addItem: (args) => Promise<id>   (for import bridge)
 *   saveItem: (id, updates) => void   (replaces PATCH)
 *   deleteItem: (id) => void           (replaces DELETE)
 *   identifyProduct: (id) => Promise   (replaces POST product-match)
 */
export function useConvexWardrobe() {
  // Skip the query until authenticated — otherwise the server throws
  // "Unauthorized: sign in required" and React unmounts the tree.
  const { isAuthenticated } = useConvexAuth();
  const rawItems = useQuery(api.wardrobe.getWardrobe, isAuthenticated ? {} : "skip");
  const updateItem = useMutation(api.wardrobe.updateWardrobeItem);
  const removeItem = useMutation(api.wardrobe.deleteWardrobeItem);
  const addItem = useMutation(api.wardrobe.addWardrobeItem);
  const matchProduct = useAction(api.wardrobe.productMatch);
  const generateModeledAction = useAction(api.wardrobe.generateModeledForItem);

  const items = (rawItems ?? []).map(mapWardrobeItem);

  return {
    items,
    loading: rawItems === undefined,
    addItem,
    saveItem: async (id, updates) => {
      // Only send fields the mutation accepts — strip UI-only fields
      const {
        name, part, color, secondaryColor, tags,
        garmentStorageId, modeledStorageId, sourceStorageId,
        brand, productName, productColorway, productUrl,
        productConfidence, productEvidence, productSources, productMatchSummary,
      } = updates;
      await updateItem({
        id,
        name, part, color, secondaryColor, tags,
        garmentStorageId, modeledStorageId, sourceStorageId,
        brand, productName, productColorway, productUrl,
        productConfidence, productEvidence, productSources, productMatchSummary,
      });
    },
    deleteItem: async (id) => {
      await removeItem({ id });
    },
    identifyProduct: async (id) => {
      // Action runs product match, patches item in DB, returns match data
      return matchProduct({ itemId: id });
    },
    generateModeled: async (id, regeneratePrompt) => {
      // On-demand modeled photo generation for a wardrobe item
      return generateModeledAction({
        itemId: id,
        regeneratePrompt: regeneratePrompt || undefined,
      });
    },
  };
}

// ─── Outfits ─────────────────────────────────────────────────────

/**
 * Hook that replaces: GET/POST/DELETE /api/import/outfits + regenerate
 *
 * Returns:
 *   outfits: Outfit[] (real-time, replaces polling!)
 *   loading: boolean
 *   createOutfit: ({ name, garmentIds, setting }) => id
 *   deleteOutfit: (id) => void
 *   regenerateOutfit: (id) => void
 */
export function useConvexOutfits() {
  const { isAuthenticated } = useConvexAuth();
  const rawOutfits = useQuery(api.outfits.getOutfits, isAuthenticated ? {} : "skip");
  const create = useMutation(api.outfits.createOutfit);
  const remove = useMutation(api.outfits.deleteOutfit);
  const regenerate = useMutation(api.outfits.regenerateOutfit);

  const outfits = (rawOutfits ?? []).map(mapOutfit);

  return {
    outfits,
    loading: rawOutfits === undefined,
    createOutfit: async ({ name, garmentIds, setting }) => {
      return create({ name, garmentIds, setting });
    },
    deleteOutfit: async (id) => {
      await remove({ id });
    },
    regenerateOutfit: async (id) => {
      await regenerate({ id });
    },
  };
}

// ─── Try-on ──────────────────────────────────────────────────────

/**
 * Hook for try-on jobs of a specific outfit.
 *
 * Tracked per-outfit so the OutfitViewer can show the latest try-on status
 * in real time (no polling). The query is "skip"ped until both authed and a
 * concrete outfitId is bound.
 *
 * Returns:
 *   jobs: TryonJob[] (real-time, newest first; each has `imageUrl`)
 *   loading: boolean
 *   startTryon: () => Promise<{ jobId }>  (deducts 10 credits, schedules AI)
 */
export function useConvexTryon(outfitId) {
  const { isAuthenticated } = useConvexAuth();
  const rawJobs = useQuery(
    api.tryon.getTryonJobs,
    isAuthenticated && outfitId ? { outfitId } : "skip"
  );
  const start = useMutation(api.tryon.startTryon);

  const jobs = useMemo(
    () => (rawJobs ?? EMPTY_ARRAY).map(mapTryonJob),
    [rawJobs]
  );

  return {
    jobs,
    loading: rawJobs === undefined,
    startTryon: async () => {
      if (!outfitId) throw new Error("useConvexTryon: no outfitId bound");
      return start({ outfitId });
    },
  };
}

// ─── Import / Upload ─────────────────────────────────────────────

/**
 * Hook that replaces: POST /api/import/jobs + model-reference
 *
 * Returns:
 *   generateUploadUrl: () => string     (for client-side file upload)
 *   startImport: (storageId, autoProcess?) => { status }
 */
export function useConvexImport() {
  const getUrl = useMutation(api.wardrobe.generateUploadUrl);
  const start = useMutation(api.import.startImport);

  return {
    generateUploadUrl: async () => {
      return getUrl({});
    },
    startImport: async (sourceStorageId, autoProcess = false) => {
      return start({ sourceStorageId, autoProcess });
    },
  };
}

// ─── Import Flow (full multi-stage pipeline) ─────────────────────

/**
 * Hook for the import-flow.jsx component.
 * Replaces all 10 fetch() calls with Convex real-time subscriptions + mutations.
 *
 * Returns:
 *   jobs: ImportJob[] (real-time, replaces polling)
 *   setup: SetupStatus (real-time, replaces GET /api/import/config)
 *   modelReferences: ModelReference[] (real-time)
 *   loading: boolean
 *   uploadAndImport: (files, autoProcess) => Promise
 *   saveModelReference: (files) => Promise
 *   approveStage: (jobId, stage) => Promise
 *   rejectStage: (jobId, stage) => Promise
 *   regenerateStage: (jobId, stage, prompt?) => Promise
 *   updateJobMetadata: (jobId, metadata) => Promise
 *   deleteJob: (jobId) => Promise
 *   retryAnalysis: (jobId) => Promise
 *   deleteModelReference: (refId) => Promise
 */
export function useConvexImportFlow() {
  const { isAuthenticated } = useConvexAuth();
  const rawJobs = useQuery(api.import.getImportJobs, isAuthenticated ? {} : "skip");
  const setupStatus = useQuery(api.import.getSetupStatus, isAuthenticated ? {} : "skip");
  const rawModelRefs = useQuery(api.import.getModelReferences, isAuthenticated ? {} : "skip");

  const generateUploadUrl = useMutation(api.wardrobe.generateUploadUrl);
  const startImport = useMutation(api.import.startImport);
  const approve = useMutation(api.import.approveStage);
  const reject = useMutation(api.import.rejectStage);
  const regenerate = useAction(api.import.regenerateStage);
  const updateMeta = useMutation(api.import.updateJobMetadata);
  const removeJob = useMutation(api.import.deleteJob);
  const retry = useAction(api.import.retryAnalysis);
  const saveRef = useMutation(api.import.saveModelReference);
  const deleteRef = useMutation(api.import.deleteModelReference);
  const cleanupPreviewAction = useAction(api.import.cleanupPreview);
  const cleanupAcceptAction = useAction(api.import.cleanupAccept);

  // Stable references for loading state — see EMPTY_ARRAY comment above.
  const jobs = useMemo(() => rawJobs ?? EMPTY_IMPORT_JOBS, [rawJobs]);
  const setup = useMemo(() => setupStatus ?? null, [setupStatus]);
  const modelReferences = useMemo(() => rawModelRefs ?? EMPTY_MODEL_REFS, [rawModelRefs]);

  return {
    jobs,
    setup,
    modelReferences,
    loading: rawJobs === undefined || setupStatus === undefined,

    /** Upload files and start imports. Returns { successes, failures }. */
    uploadAndImport: async (files, autoProcess = false) => {
      const images = [...files].filter((file) => file.type.startsWith("image/"));
      if (!images.length) return { successes: 0, failures: [] };

      const failures = [];
      let successes = 0;

      // Process up to 3 files concurrently (same concurrency as old code)
      let cursor = 0;
      const worker = async () => {
        while (cursor < images.length) {
          const file = images[cursor];
          cursor += 1;
          try {
            // Step 1: Get upload URL
            const uploadUrl = await generateUploadUrl({});
            // Step 2: POST binary to Convex storage
            const uploadResp = await fetch(uploadUrl, {
              method: "POST",
              headers: { "Content-Type": file.type || "image/png" },
              body: file,
            });
            if (!uploadResp.ok) throw new Error(`Upload failed: ${uploadResp.status}`);
            const { storageId } = await uploadResp.json();
            // Step 3: Start import
            await startImport({ sourceStorageId: storageId, autoProcess });
            successes += 1;
          } catch (error) {
            failures.push({ file: file.name, error });
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(3, images.length) }, () => worker())
      );

      return { successes, failures };
    },

    /** Save model reference photos. */
    saveModelReference: async (files) => {
      const images = [...files].filter((file) => file.type.startsWith("image/"));
      if (!images.length) return;

      for (const file of images) {
        const uploadUrl = await generateUploadUrl({});
        const uploadResp = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": file.type || "image/png" },
          body: file,
        });
        if (!uploadResp.ok) throw new Error(`Upload failed: ${uploadResp.status}`);
        const { storageId } = await uploadResp.json();
        await saveRef({ storageId });
      }
    },

    approveStage: async (jobId, stage) => {
      await approve({ jobId, stage });
    },

    rejectStage: async (jobId, stage) => {
      await reject({ jobId, stage });
    },

    regenerateStage: async (jobId, stage, prompt = "") => {
      await regenerate({ jobId, stage, prompt: prompt || undefined });
    },

    updateJobMetadata: async (jobId, metadata) => {
      await updateMeta({ jobId, metadata });
    },

    deleteJob: async (jobId) => {
      await removeJob({ jobId });
    },

    retryAnalysis: async (jobId) => {
      await retry({ jobId });
    },

    deleteModelReference: async (refId) => {
      await deleteRef({ refId });
    },

    cleanupPreview: async (jobId, tolerance) => {
      return cleanupPreviewAction({ jobId, tolerance });
    },

    cleanupAccept: async (jobId) => {
      return cleanupAcceptAction({ jobId });
    },
  };
}

// ─── Credits ─────────────────────────────────────────────────────

export function useConvexCredits() {
  const { isAuthenticated } = useConvexAuth();
  const balance = useQuery(api.credits.getBalance, isAuthenticated ? {} : "skip");
  const grant = useMutation(api.credits.grantMonthlyCredits);

  return {
    balance: balance ?? { balance: 0, plan: "free" },
    loading: balance === undefined,
    grantMonthly: grant,
  };
}

// ─── Planner ─────────────────────────────────────────────────────

export function useConvexPlanner(startDate, endDate) {
  const entries = useQuery(api.planner.getPlanner, {
    startDate: startDate || "2026-01-01",
    endDate: endDate || "2026-12-31",
  });
  const plan = useMutation(api.planner.planOutfit);
  const remove = useMutation(api.planner.removePlannerEntry);

  return {
    entries: entries ?? [],
    loading: entries === undefined,
    planOutfit: async ({ date, outfitId, note }) => {
      return plan({ date, outfitId, note });
    },
    removePlannedOutfit: async (id) => {
      await remove({ id });
    },
  };
}

// ─── Profile ─────────────────────────────────────────────────────

export function useConvexProfile() {
  const profile = useQuery(api.profile.getProfile);
  const update = useMutation(api.profile.updateProfile);

  return {
    profile: profile ?? null,
    loading: profile === undefined,
    updateProfile: update,
  };
}

// ─── Auth ────────────────────────────────────────────────────────

export function useConvexAuth() {
  const user = useQuery(api.helpers.currentUser);

  return {
    user,
    isAuthenticated: user !== null,
    loading: user === undefined,
  };
}
