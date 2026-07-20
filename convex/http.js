import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { handleMcpRequest, handleCorsPreflight } from "./mcp";

const http = httpRouter();

// Auth routes
auth.addHttpRoutes(http);

// ─── MCP endpoint ────────────────────────────────────────────────
// POST /mcp — handles JSON-RPC requests (initialize, tools/list, tools/call)
http.route({
  path: "/mcp",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    return handleMcpRequest(ctx, request);
  }),
});

// OPTIONS /mcp — CORS preflight
http.route({
  path: "/mcp",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, _request) => {
    return handleCorsPreflight();
  }),
});

// GET /mcp — SSE keep-alive (return empty OK for now)
http.route({
  path: "/mcp",
  method: "GET",
  handler: httpAction(async (_ctx, _request) => {
    return handleCorsPreflight();
  }),
});

// DELETE /mcp — session terminate
http.route({
  path: "/mcp",
  method: "DELETE",
  handler: httpAction(async (_ctx, _request) => {
    return handleCorsPreflight();
  }),
});

export default http;
