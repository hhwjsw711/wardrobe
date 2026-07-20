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
  v.literal("refund"),
  v.literal("grant"),
  v.literal("purchase"),
);

const ProductConfidence = v.union(
  v.literal("exact"),
  v.literal("likely"),
  v.literal("unknown"),
);

// ─── Schema ─────────────────────────────────────────────────────

export default defineSchema({
  ...authTables,
  // ─── App tables ───────────────────────────────────────────────────
  // users table is provided by authTables with: _id, _creationTime, email, name, emailVerificationTime, isAnonymous, image
  // We extend it in the code layer (plan, creditBalance, stripeCustomerId stored via patch)

  // 2. Wardrobe Items
  wardrobeItems: defineTable({
    userId: v.id("users"),
    name: v.string(),                    // max 120 chars
    part: Part,
    color: v.string(),                   // hex "#rrggbb" lowercase
    secondaryColor: v.optional(v.string()),
    tags: v.array(v.string()),           // max 12, each ≤40 chars
    garmentStorageId: v.optional(v.id("_storage")),  // cutout image — optional for MCP text-only creation
    modeledStorageId: v.optional(v.id("_storage")),  // editorial modeled photo
    sourceStorageId: v.optional(v.id("_storage")),    // original uploaded photo
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
  })
    .index("by_user", ["userId"])
    .index("by_user_date", ["userId", "date"]),

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
});
