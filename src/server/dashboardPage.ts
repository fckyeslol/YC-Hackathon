import Fastify, { type FastifyInstance } from "fastify";
import type { DashboardData } from "../dashboard/types.js";
import { renderDashboard } from "../dashboard/renderDashboard.js";

/**
 * The personal dashboard page (spec dashboard-visualization BR-D2). Served by the
 * main Fastify server at `GET /dashboard/:token`. A valid, unexpired token resolves
 * to a full-detail page; anything else is a 404 that leaks no financial data.
 *
 * Dependency-injected so it runs under `app.inject` without a live link store.
 */

export interface DashboardPageDeps {
  /** Resolve a token to its payload, or undefined if missing/expired (BR-D2). */
  resolve: (token: string) => DashboardData | undefined;
}

const NOT_FOUND = "<!doctype html><meta charset=utf-8><title>Invalid link</title><h1>Invalid or expired link</h1><p>Ask Verdict for a new dashboard over iMessage.</p>";

export function registerDashboardRoutes(app: FastifyInstance, deps: DashboardPageDeps): void {
  app.get<{ Params: { token: string } }>("/dashboard/:token", async (request, reply) => {
    const data = deps.resolve(request.params.token);
    if (!data) return reply.code(404).type("text/html").send(NOT_FOUND);
    return reply.code(200).type("text/html").send(renderDashboard(data));
  });
}

/** Standalone app (used by tests). Production mounts the route on the main server. */
export function buildDashboardApp(deps: DashboardPageDeps): FastifyInstance {
  const app = Fastify({ logger: false }); // no logging: dashboard content is personal
  registerDashboardRoutes(app, deps);
  return app;
}
