import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { handleMcpRequest, handleCorsPreflight } from "./mcp";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";

const http = httpRouter();

// Auth routes
auth.addHttpRoutes(http);

// ─── MCP endpoint (Streamable HTTP transport) ──────────────────
// MUST be registered BEFORE registerStaticRoutes, because static
// hosting adds a catch-all SPA fallback that would otherwise match /mcp.
// Auth: Bearer <mcpApiKey> header. Generate key from Profile page.

http.route({
  path: "/mcp",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    return handleMcpRequest(ctx, request);
  }),
});

http.route({
  path: "/mcp",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, _request) => {
    return handleCorsPreflight();
  }),
});

// GET: Not supported (no server-initiated SSE in this MVP).
// Return 405 per MCP Streamable HTTP spec.
http.route({
  path: "/mcp",
  method: "GET",
  handler: httpAction(async (_ctx, _request) => {
    return new Response(null, {
      status: 405,
      headers: {
        "Access-Control-Allow-Origin": "*",
        Allow: "POST, OPTIONS",
      },
    });
  }),
});

// DELETE: Session termination (no-op for this stateless MVP).
http.route({
  path: "/mcp",
  method: "DELETE",
  handler: httpAction(async (_ctx, _request) => {
    return new Response(null, {
      status: 204,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }),
});

// Static hosting routes — serves the built frontend from Convex storage.
// SPA fallback enabled so client-side routing works for all paths.
// Registered AFTER MCP routes so /mcp is matched before the catch-all.
registerStaticRoutes(http, components.selfHosting);

export default http;
