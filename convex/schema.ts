import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

// ─── Enums (shared value types) ──────────────────────────────────

const Part = v.union(
  v.literal("upperbody"),
  v.literal("wholebody_up"),
  v.literal("lowerbody"),
  v.literal("accessories_up"),
  v.literal("shoes"),
);

const OutfitStatus = v.union(
  v.literal("generating"),
  v.literal("ready"),
  v.literal("failed"),
  v.literal("stalled"),
);

const Plan = v.union(v.literal("free"), v.literal("pro"), v.literal("max"));

const CreditReason = v.union(
  v.literal("tryon"),
  v.literal("search"),
  v.literal("analyze"),
  v.literal("modeled"),
  v.literal("refund"),
  v.literal("grant"),
  v.literal("purchase"),
);

const ProductConfidence = v.union(
  v.literal("exact"),
  v.literal("likely"),
  v.literal("unknown"),
);

const JobKind = v.union(v.literal("upload"), v.literal("item"));
const AnalysisStatus = v.union(
  v.literal("queued"),
  v.literal("processing"),
  v.literal("complete"),
  v.literal("failed"),
  v.literal("empty"),
);
const StageStatus = v.union(
  v.literal("pending"),
  v.literal("processing"),
  v.literal("review"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("failed"),
);
const ProductMatchJobStatus = v.union(
  v.literal("pending"),
  v.literal("processing"),
  v.literal("complete"),
  v.literal("failed"),
);

// ─── Schema ─────────────────────────────────────────────────────

export default defineSchema({
  ...authTables,
  // ─── App tables ───────────────────────────────────────────────────
  // NOTE: Convex Auth's `users` table (from authTables) has a strict
  // validator that only allows auth fields (email, name, image, etc.).
  // It CANNOT be extended with app fields like plan/creditBalance via
  // db.patch — the write will be rejected by schema validation.
  // App-level per-user data lives in the `userProfiles` table below,
  // joined 1:1 with `users` by userId.

  // 1. User Profiles (app-level extension of auth users)
  userProfiles: defineTable({
    userId: v.id("users"),
    plan: Plan,                          // "free" | "pro" | "max"
    creditBalance: v.number(),           // current credits, kept in sync with creditLedger
    stripeCustomerId: v.optional(v.string()),
    mcpApiKey: v.optional(v.string()),  // API key for MCP server access
  })
    .index("by_user", ["userId"])
    .index("by_mcp_api_key", ["mcpApiKey"]),

  // 2. Wardrobe Items
  wardrobeItems: defineTable({
    userId: v.id("users"),
    name: v.string(),                    // max 120 chars
    part: Part,
    color: v.string(),                   // hex "#rrggbb" lowercase
    secondaryColor: v.optional(v.union(v.string(), v.null())),
    tags: v.array(v.string()),           // max 12, each ≤40 chars
    garmentStorageId: v.optional(v.id("_storage")),  // cutout image — optional for MCP text-only creation
    modeledStorageId: v.optional(v.id("_storage")),  // editorial modeled photo
    sourceStorageId: v.optional(v.id("_storage")),    // original uploaded photo
    importJobId: v.optional(v.string()),              // bridge: maps to old import-job-api job ID
    // Product match fields
    brand: v.optional(v.string()),
    productName: v.optional(v.string()),
    productColorway: v.optional(v.string()),
    productUrl: v.optional(v.string()),
    productConfidence: v.optional(ProductConfidence),
    productEvidence: v.optional(v.array(v.string())),
    productSources: v.optional(v.array(v.object({
      url: v.string(),
      title: v.optional(v.string()),
    }))),
    productMatchSummary: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_user_part", ["userId", "part"]),

  // 3. Outfits
  outfits: defineTable({
    userId: v.id("users"),
    name: v.string(),                    // max 120 chars
    garmentIds: v.array(v.id("wardrobeItems")),  // 2–6 items
    setting: v.optional(v.string()),     // scene description, max 300 chars
    status: OutfitStatus,
    imageStorageId: v.optional(v.id("_storage")),  // generated outfit image
    error: v.optional(v.string()),
    description: v.optional(v.string()),  // AI editorial note, max 300 chars
    tags: v.array(v.string()),           // 0–4 uppercase style tags
  })
    .index("by_user", ["userId"])
    .index("by_user_status", ["userId", "status"]),

  // 4. Try-on Jobs
  tryonJobs: defineTable({
    userId: v.id("users"),
    outfitId: v.id("outfits"),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("done"),
      v.literal("failed"),
    ),
    imageStorageId: v.optional(v.id("_storage")),  // try-on result image
    error: v.optional(v.string()),
    completedAt: v.optional(v.number()),  // _creationTime-style ms timestamp
  })
    .index("by_user", ["userId"])
    .index("by_outfit", ["outfitId"]),

  // 5. Planner Entries (week calendar)
  plannerEntries: defineTable({
    userId: v.id("users"),
    date: v.string(),                    // "YYYY-MM-DD"
    outfitId: v.optional(v.id("outfits")),
    note: v.optional(v.string()),
    worn: v.optional(v.boolean()),        // true = marked as actually worn that day
  })
    .index("by_user", ["userId"])
    .index("by_user_date", ["userId", "date"]),

  // 7. Import Jobs (multi-stage human-in-the-loop import pipeline)
  importJobs: defineTable({
    userId: v.id("users"),
    kind: JobKind,
    sourceStorageId: v.optional(v.id("_storage")),  // uploaded photo
    metadata: v.optional(v.object({
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
      productName: v.optional(v.string()),
      brand: v.optional(v.string()),
      productConfidence: v.optional(v.string()),
      productUrl: v.optional(v.string()),
    })),
    analysis: v.optional(v.object({
      status: AnalysisStatus,
      error: v.optional(v.string()),
    })),
    stages: v.optional(v.object({
      crop: v.optional(v.object({
        status: StageStatus,
        storageId: v.optional(v.id("_storage")),
        error: v.optional(v.string()),
      })),
      garment: v.optional(v.object({
        status: StageStatus,
        storageId: v.optional(v.id("_storage")),
        error: v.optional(v.string()),
        failedStorageId: v.optional(v.id("_storage")),
        chromaKey: v.optional(v.string()),
        cleanupTolerance: v.optional(v.number()),
        cleanupDiagnostics: v.optional(v.object({
          contaminatedPixels: v.number(),
          maxSpill: v.number(),
        })),
        cleanupPreviewStorageId: v.optional(v.id("_storage")),
      })),
      modeled: v.optional(v.object({
        status: StageStatus,
        storageId: v.optional(v.id("_storage")),
        error: v.optional(v.string()),
      })),
    })),
    productMatch: v.optional(v.object({
      status: ProductMatchJobStatus,
    })),
    wardrobeItemId: v.optional(v.id("wardrobeItems")),  // created when garment is approved
    autoProcess: v.optional(v.boolean()),
  })
    .index("by_user", ["userId"]),

  // 8. Model References (styling reference photos for modeled image generation)
  modelReferences: defineTable({
    userId: v.id("users"),
    storageId: v.id("_storage"),
  })
    .index("by_user", ["userId"]),

  // 6. Credit Ledger (append-only, real source of truth)
  creditLedger: defineTable({
    userId: v.id("users"),
    delta: v.number(),                   // positive=credit/refund, negative=consume
    reason: CreditReason,
    refId: v.optional(v.string()),        // tryonJob _id or stripe charge id
    balanceAfter: v.number(),            // snapshot after this transaction
  })
    .index("by_user", ["userId"])
    .index("by_user_reason", ["userId", "reason"]),

  // 9. Usage Logs (cost observability — one row per OpenAI API call)
  // Inspired by klapp101/wardrobe PR #5 (cost_observability). Adapted to Convex:
  // file-append log → DB table; admin endpoint → admin-gated query.
  usageLogs: defineTable({
    userId: v.optional(v.id("users")),
    at: v.number(),                              // ms timestamp (Date.now())
    endpoint: v.string(),                        // "images/edits" | "responses"
    label: v.string(),                           // "analyze" | "garment" | "modeled" | "tryon" | "outfit" | "outfit-analyze" | "product-match"
    model: v.string(),
    inputTokens: v.number(),                     // total input tokens (text + image)
    textInputTokens: v.number(),                 // text-only input tokens
    imageInputTokens: v.number(),                // image input tokens (billed at separate rate)
    outputTokens: v.number(),
    cost: v.optional(v.number()),                // USD; omitted when model pricing unknown (defensive)
    jobId: v.optional(v.string()),               // import job ID if applicable
    itemId: v.optional(v.id("wardrobeItems")),   // wardrobe item ID if applicable
  })
    .index("by_user", ["userId"])
    .index("by_label", ["label"])
    .index("by_model", ["model"])
    .index("by_at", ["at"]),
});
