import { Router } from "express";

export interface HealthDeps {
  qlooConfigured: () => boolean;
  llmConfigured: () => boolean;
  model: string | undefined;
}

/** GET /api/health. Reports booleans only, never secret values. */
export function createHealthRouter(deps: HealthDeps): Router {
  const router = Router();
  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      qloo: deps.qlooConfigured(),
      llm: deps.llmConfigured(),
      model: deps.model ?? null,
    });
  });
  return router;
}
