import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Root route — used by Render health checks and keep-alive pings
router.get("/", (_req, res) => {
  res.json({ status: "ok", service: "sentinel-api", time: new Date().toISOString() });
});

export default router;
