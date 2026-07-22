import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { handleMcpRequest, handleCorsPreflight } from "./mcp";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";

const http = httpRouter();

// Auth routes
auth.addHttpRoutes(http);

// Static hosting routes — serves the built frontend from Convex storage.
// SPA fallback enabled so client-side routing works for all paths.
registerStaticRoutes(http, components.selfHosting);

// ─── MCP endpoint (DISABLED — raw userId Bearer auth is insecure) ──
// Re-enable only after implementing JWT-based authentication.
// See A-02 in adversarial audit.
//
// http.route({
//   path: "/mcp",
//   method: "POST",
//   handler: httpAction(async (ctx, request) => {
//     return handleMcpRequest(ctx, request);
//   }),
// });
//
// http.route({
//   path: "/mcp",
//   method: "OPTIONS",
//   handler: httpAction(async (_ctx, _request) => {
//     return handleCorsPreflight();
//   }),
// });
//
// http.route({
//   path: "/mcp",
//   method: "GET",
//   handler: httpAction(async (_ctx, _request) => {
//     return handleCorsPreflight();
//   }),
// });
//
// http.route({
//   path: "/mcp",
//   method: "DELETE",
//   handler: httpAction(async (_ctx, _request) => {
//     return handleCorsPreflight();
//   }),
// });

export default http;
