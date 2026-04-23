// ─── GENERATORS ROUTE ────────────────────────────────────────────────────────
// Thin route layer: authenticate → validate → enforce → generate → format → respond.
// No AI logic, no prompts, no credit math, no business rules live here.
// All sensitive logic is in services/aiService.js and middleware/.

import { Router } from "express";
import { requireAuth }               from "../middleware/auth.js";
import { generateIpLimiter, generateUserLimiter } from "../middleware/rateLimiter.js";
import { enforceCreditLimit }        from "../middleware/planEnforcement.js";
import { enforceTrialLimit, incrementFingerprintUsage } from "../middleware/trialGuard.js";
import { validateGenerationRequest, validateSaveRequest, validateTemplateRequest } from "../middleware/validateRequest.js";
import { generate, applyPlanGating, getTool } from "../services/aiService.js";
import { formatGenerationResponse, formatUsageResponse, formatSavedRow, formatTemplate, generationErrorResponse } from "../services/responseFormatter.js";
import { getDb }           from "../db/database.js";
import { getPlan, remainingCredits } from "../config/plans.js";

const router = Router();
router.use(requireAuth);

// ── POST /generate/:toolId ────────────────────────────────────────────────────

router.post(
  "/generate/:toolId",
  generateIpLimiter,
  validateGenerationRequest,   // validates + attaches req.validated
  enforceCreditLimit,          // blocks if insufficient credits
  enforceTrialLimit,           // blocks if trial fingerprint exhausted
  generateUserLimiter,         // per-user hourly DB check (runs last, cheapest to move here)
  async (req, res) => {
    const { toolId, toolInput } = req.validated;
    const tool = getTool(toolId);

    try {
      const raw    = await generate(toolId, toolInput);
      const output = applyPlanGating(toolId, raw, req.userPlan);

      const db      = getDb();
      const cost    = req.creditCostForTool;
      const planId  = req.userPlan ?? "starter";
      const plan    = getPlan(planId);
      const eventId = Math.random().toString(36).slice(2) + Date.now().toString(36);

      db.prepare(
        "INSERT INTO usage_events (id, user_id, event_type, tool_id, credits_used) VALUES (?, ?, 'generation', ?, ?)"
      ).run(eventId, req.userId, toolId, cost);

      if (req.trialFingerprint) {
        incrementFingerprintUsage(db, req.trialFingerprint, cost);
      }

      return res.json(
        formatGenerationResponse(output, req.creditsUsed ?? 0, plan.creditsPerMonth, cost)
      );
    } catch (err) {
      // Log internally — never expose error details to client
      console.error(`[generate] toolId=${toolId} userId=${req.userId} err=${err?.message ?? err}`);

      const type = err?.type ?? (
        err?.status === 401 ? "service_unavailable" :
        err?.status === 429 ? "busy" :
        (typeof err?.status === "number" && err.status >= 500) ? "unavailable" : "unknown"
      );
      const httpStatus = type === "busy" ? 429 : type === "unavailable" ? 502 : 500;
      return res.status(httpStatus).json(generationErrorResponse(type));
    }
  }
);

// ── GET /saved/count ──────────────────────────────────────────────────────────

router.get("/saved/count", (req, res) => {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM saved_generations WHERE user_id = ?")
    .get(req.userId);
  return res.json({ count: row.count });
});

// ── GET /saved ────────────────────────────────────────────────────────────────

router.get("/saved", (req, res) => {
  const rows = getDb()
    .prepare("SELECT * FROM saved_generations WHERE user_id = ? ORDER BY created_at DESC")
    .all(req.userId);
  return res.json({ saved: rows.map(formatSavedRow) });
});

// ── POST /saved ───────────────────────────────────────────────────────────────

router.post("/saved", validateSaveRequest, (req, res) => {
  const { toolId, output, formData } = req.validated;
  const tool  = getTool(toolId);
  const id    = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const title = (formData[tool.titleField] || "Untitled").slice(0, 120);
  const db    = getDb();

  db.prepare(
    "INSERT INTO saved_generations (id, user_id, tool_id, tool_label, title, form_data, output) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, req.userId, toolId, tool.label, title, JSON.stringify(formData), output);

  const row = db.prepare("SELECT * FROM saved_generations WHERE id = ?").get(id);
  return res.status(201).json({ item: formatSavedRow(row) });
});

// ── DELETE /saved/:id ─────────────────────────────────────────────────────────

router.delete("/saved/:id", (req, res) => {
  const db  = getDb();
  const row = db.prepare(
    "SELECT id FROM saved_generations WHERE id = ? AND user_id = ?"
  ).get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: "Not found." });
  db.prepare("DELETE FROM saved_generations WHERE id = ?").run(req.params.id);
  return res.json({ deleted: true });
});

// ── GET /usage ────────────────────────────────────────────────────────────────

router.get("/usage", (req, res) => {
  const db     = getDb();
  const planId = req.userPlan ?? "starter";
  const plan   = getPlan(planId);

  const monthly = db.prepare(`
    SELECT COALESCE(SUM(credits_used), 0) AS total FROM usage_events
    WHERE user_id = ? AND event_type = 'generation'
      AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
  `).get(req.userId);

  const byToolRows = db.prepare(`
    SELECT tool_id, SUM(credits_used) AS credits FROM usage_events
    WHERE user_id = ? AND event_type = 'generation'
      AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    GROUP BY tool_id
  `).all(req.userId);

  const allTime = db.prepare(`
    SELECT COALESCE(SUM(credits_used), 0) AS total FROM usage_events
    WHERE user_id = ? AND event_type = 'generation'
  `).get(req.userId);

  let effectiveUsed = monthly.total;
  if (planId === "trial") {
    const user = db.prepare("SELECT reg_fingerprint FROM users WHERE id = ?").get(req.userId);
    if (user?.reg_fingerprint) {
      const reg = db.prepare(
        "SELECT total_credits_used FROM fingerprint_registry WHERE fingerprint = ?"
      ).get(user.reg_fingerprint);
      if (reg) effectiveUsed = reg.total_credits_used;
    }
  }

  const byTool = byToolRows.reduce((acc, r) => { acc[r.tool_id] = r.credits; return acc; }, {});

  return res.json(
    formatUsageResponse(effectiveUsed, plan.creditsPerMonth, allTime.total, byTool)
  );
});

// ── GET /templates ────────────────────────────────────────────────────────────

router.get("/templates", (req, res) => {
  const rows = getDb()
    .prepare("SELECT * FROM saved_templates WHERE user_id = ? ORDER BY created_at DESC")
    .all(req.userId);
  return res.json({ templates: rows.map(formatTemplate) });
});

// ── POST /templates ───────────────────────────────────────────────────────────

router.post("/templates", validateTemplateRequest, (req, res) => {
  const { toolId, name, description, formData } = req.validated;
  const tool = getTool(toolId);
  const id   = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const db   = getDb();

  db.prepare(
    "INSERT INTO saved_templates (id, user_id, tool_id, tool_label, name, description, form_data) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, req.userId, toolId, tool.label, name, description, JSON.stringify(formData));

  const row = db.prepare("SELECT * FROM saved_templates WHERE id = ?").get(id);
  return res.status(201).json({ template: formatTemplate(row) });
});

// ── DELETE /templates/:id ─────────────────────────────────────────────────────

router.delete("/templates/:id", (req, res) => {
  const db  = getDb();
  const row = db.prepare(
    "SELECT id FROM saved_templates WHERE id = ? AND user_id = ?"
  ).get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: "Not found." });
  db.prepare("DELETE FROM saved_templates WHERE id = ?").run(req.params.id);
  return res.json({ deleted: true });
});

export default router;
