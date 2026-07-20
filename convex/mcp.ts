import { v } from "convex/values";
import { api } from "./_generated/api";

// ─── MCP Tool Definitions ────────────────────────────────────────
// 11 tools mapped to Convex backend functions.
// Aesty validated: try-on (10 credits) and photo search (5 credits) cost money.
// Reading wardrobe, building outfits, planning are all free.

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
    name: "add_wardrobe_items",
    description:
      "Add an item to the wardrobe. Provide name, part, color, and optionally tags. Images must be uploaded separately first.",
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

  // ─── Outfits (3 tools) ─────────────────────────────────
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

  // ─── Try-on (2 tools, 10 credits each) ─────────────────
  {
    name: "try_on",
    description:
      "Start a virtual try-on for an outfit. Costs 10 credits. Returns a try-on job ID.",
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

  // ─── Planner (2 tools, free) ────────────────────────────
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
];

// ─── MCP JSON-RPC Protocol Handler ──────────────────────────────

export async function handleMcpRequest(
  ctx: any,
  request: Request
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Mcp-Session-Id",
  };

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
        corsHeaders
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
          corsHeaders
        );
    }

    return jsonResponse({ jsonrpc: "2.0", id, result }, corsHeaders);
  } catch (e: any) {
    return jsonResponse(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: e.message || "Internal error" },
      },
      { "Access-Control-Allow-Origin": "*" }
    );
  }
}

export function handleCorsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, Mcp-Session-Id",
    },
  });
}

// ─── Tools Call Router ───────────────────────────────────────────
// Uses ctx.runQuery / ctx.runMutation / ctx.runAction to call Convex functions.
// This is the correct way to access the database from HTTP actions.

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
      const items = await ctx.runQuery(api.wardrobe.getWardrobe, {});
      return toolResult(items, [
        `Wardrobe has ${items.length} items. Each has: name, part, color, tags.`,
      ]);
    }
    case "get_wardrobe_item": {
      const item = await ctx.runQuery(api.wardrobe.getWardrobeItem, {
        id: args.id,
      });
      if (!item) return toolError("Item not found");
      return toolResult([item], ["Details of the requested item."]);
    }
    case "add_wardrobe_items": {
      const itemId = await ctx.runMutation(api.wardrobe.addWardrobeItem, {
        name: args.name,
        part: args.part,
        color: args.color || "#333333",
        secondaryColor: args.secondaryColor,
        tags: args.tags || [],
      });
      return toolResult([{ id: itemId }], [
        "Item added to wardrobe.",
        "Note: For full item creation with images, use the web app upload flow.",
      ]);
    }
    case "remove_wardrobe_item": {
      await ctx.runMutation(api.wardrobe.deleteWardrobeItem, {
        id: args.id,
      });
      return toolResult([{ id: args.id, deleted: true }], [
        "Item removed from wardrobe.",
      ]);
    }

    // ─── Outfits ──────────────────────────────────────────
    case "get_outfit_history": {
      const outfits = await ctx.runQuery(api.outfits.getOutfits, {});
      // Simplify for MCP — strip full image URLs, keep key info
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
      const outfitId = await ctx.runMutation(api.outfits.createOutfit, {
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
      const items = await ctx.runQuery(api.wardrobe.getWardrobe, {});
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

    // ─── Try-on ───────────────────────────────────────────
    case "try_on": {
      const job = await ctx.runMutation(api.tryon.startTryon, {
        outfitId: args.outfit_id,
      });
      return toolResult(
        [{ id: job.jobId, status: "pending", creditsUsed: 10 }],
        [
          "Try-on started. 10 credits deducted.",
          "Use get_tryon_result to check status.",
        ]
      );
    }
    case "get_tryon_result": {
      const result = await ctx.runQuery(api.tryon.getTryonResult, {
        id: args.id,
      });
      if (!result) return toolError("Try-on job not found");
      return toolResult([result], [
        `Status: ${result.status}. Done = image available.`,
      ]);
    }

    // ─── Planner ──────────────────────────────────────────
    case "get_planned_outfits": {
      const entries = await ctx.runQuery(api.planner.getPlanner, {
        startDate: args.start_date,
        endDate: args.end_date,
      });
      return toolResult(entries, [
        `Planned outfits from ${args.start_date} to ${args.end_date}.`,
      ]);
    }
    case "plan_outfit": {
      const entryId = await ctx.runMutation(api.planner.planOutfit, {
        date: args.date,
        outfitId: args.outfit_id,
        note: args.note,
      });
      return toolResult(
        [{ id: entryId, date: args.date }],
        ["Outfit planned for " + args.date + "."]
      );
    }

    default:
      throw new Error(`Tool not implemented: ${name}`);
  }
}

// ─── Auth ───────────────────────────────────────────────────────

async function authenticate(request: Request, ctx: any): Promise<string> {
  // MVP auth: Bearer token = Convex user ID
  // Production TODO: Validate JWT from Convex Auth using JWKS
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error(
      "Missing Authorization header. Provide: Bearer <userId>"
    );
  }
  const token = authHeader.slice(7);
  if (!token) throw new Error("Empty Bearer token");

  // Verify user exists by querying the currentUser function
  // For MVP, we trust the user ID and let the Convex functions handle authorization
  return token;
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
