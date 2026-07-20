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
import { api } from "../../convex/_generated/api";

// ─── Data Shape Mappers ──────────────────────────────────────────

/**
 * Map a Convex wardrobe item to the shape App.jsx expects.
 *
 * Convex returns: { _id, garmentUrl, modeledUrl, sourceUrl, ... }
 * App.jsx expects: { id, image, thumbnail, modeledImage, palette, ... }
 */
function mapWardrobeItem(item) {
  return {
    id: item._id,
    importJobId: item.importJobId || null,
    name: item.name,
    part: item.part,
    color: item.color,
    secondaryColor: item.secondaryColor ?? null,
    tags: item.tags || [],
    image: item.garmentUrl || item.sourceUrl || "",
    thumbnail: item.garmentUrl || item.sourceUrl || "",
    modeledImage: item.modeledUrl || null,
    palette: [item.color, item.secondaryColor].filter(Boolean),
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
  const rawItems = useQuery(api.wardrobe.getWardrobe);
  const updateItem = useMutation(api.wardrobe.updateWardrobeItem);
  const removeItem = useMutation(api.wardrobe.deleteWardrobeItem);
  const addItem = useMutation(api.wardrobe.addWardrobeItem);
  const matchProduct = useAction(api.wardrobe.productMatch);

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
  const rawOutfits = useQuery(api.outfits.getOutfits);
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
    startImport: async (sourceStorageId, autoProcess = true) => {
      return start({ sourceStorageId, autoProcess });
    },
  };
}

// ─── Credits ─────────────────────────────────────────────────────

export function useConvexCredits() {
  const balance = useQuery(api.credits.getBalance);
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
