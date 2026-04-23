// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────
// Owner-only endpoints for managing the product.
// All routes require requireAuth + requireOwner middleware.
// These are never exposed in the frontend — accessed via curl or a
// simple admin tool only the owner uses.
//
// Usage:
//   Promote an account to owner:
//     PATCH /api/admin/users/:id/plan  { plan: "owner", isOwner: true }
//   Set a subscriber's plan manually (while Stripe is not yet live):
//     PATCH /api/admin/users/:id/plan  { plan: "growth" }
//   List all users:
//     GET /api/admin/users

import { Router }     from "express";
import { requireAuth, requireOwner } from "../middleware/auth.js";
import { getDb }      from "../db/database.js";
import { VALID_PLAN_IDS } from "../config/plans.js";

const router = Router();
router.use(requireAuth, requireOwner);

// ── GET /users ────────────────────────────────────────────────────────────────

router.get("/users", (req, res) => {
  const db    = getDb();
  const users = db.prepare(`
    SELECT id, name, email, plan, is_owner, email_verified,
           stripe_customer_id, stripe_sub_status, created_at
    FROM users ORDER BY created_at DESC
  `).all();
  return res.json({ users });
});

// ── PATCH /users/:id/plan ─────────────────────────────────────────────────────
// Set a user's plan and optionally make them an owner.
// This is the manual upgrade path before Stripe is live.

router.patch("/users/:id/plan", (req, res) => {
  const { plan, isOwner } = req.body;
  const db = getDb();

  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found." });

  if (plan && !VALID_PLAN_IDS.includes(plan)) {
    return res.status(400).json({ error: `Invalid plan. Valid values: ${VALID_PLAN_IDS.join(", ")}` });
  }

  const updates = [];
  const params  = [];
  if (plan !== undefined)    { updates.push("plan = ?");     params.push(plan); }
  if (isOwner !== undefined) { updates.push("is_owner = ?"); params.push(isOwner ? 1 : 0); }

  if (updates.length === 0) {
    return res.status(400).json({ error: "Nothing to update." });
  }

  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);

  db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  const updated = db.prepare(
    "SELECT id, name, email, plan, is_owner, email_verified FROM users WHERE id = ?"
  ).get(req.params.id);

  return res.json({ user: updated });
});

// ── DELETE /users/:id ─────────────────────────────────────────────────────────

router.delete("/users/:id", (req, res) => {
  const db = getDb();
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found." });
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  return res.json({ deleted: true });
});

// ── GET /stats ────────────────────────────────────────────────────────────────

router.get("/stats", (req, res) => {
  const db = getDb();
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_users,
      SUM(CASE WHEN plan = 'starter' THEN 1 ELSE 0 END) AS starter_count,
      SUM(CASE WHEN plan = 'growth'  THEN 1 ELSE 0 END) AS growth_count,
      SUM(CASE WHEN plan = 'team'    THEN 1 ELSE 0 END) AS team_count,
      SUM(CASE WHEN plan = 'owner'   THEN 1 ELSE 0 END) AS owner_count,
      SUM(CASE WHEN plan = 'trial'   THEN 1 ELSE 0 END) AS trial_count
    FROM users
  `).get();

  const generations = db.prepare(`
    SELECT COUNT(*) AS total, tool_id,
           SUM(credits_used) AS credits
    FROM usage_events WHERE event_type = 'generation'
    GROUP BY tool_id ORDER BY credits DESC
  `).all();

  return res.json({ totals, generations });
});

export default router;
