// ─── CREDIT ENFORCEMENT MIDDLEWARE ───────────────────────────────────────────
// Owner accounts bypass all credit checks.
// Paid accounts are checked against monthly usage.
// Trial plan no longer exists as a default — existing trial rows are treated
// as zero-credit accounts that require an upgrade.

import { getDb } from "../db/database.js";
import { getPlan, getCreditCost } from "../config/plans.js";
import { getActiveAddOnCredits } from "../services/creditAddOns.js";

export function enforceCreditLimit(req, res, next) {
  // Owner bypasses everything
  if (req.isOwner || req.userPlan === "owner") return next();

  const db     = getDb();
  const toolId = req.params.toolId;
  const planId = req.userPlan ?? "starter";

  // Pending and trial accounts: no generation access — subscription required
  if (planId === "pending" || planId === "trial") {
    return res.status(402).json({
      error: "A paid subscription is required to use Shepherd's Desk. Choose a plan to get started.",
      code:  "SUBSCRIPTION_REQUIRED",
    });
  }

  const row = db.prepare(`
    SELECT COALESCE(SUM(credits_used), 0) AS total
    FROM usage_events
    WHERE user_id    = ?
      AND event_type = 'generation'
      AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
  `).get(req.userId);

  const creditsUsed = row?.total ?? 0;
  const plan = getPlan(planId);
  const cost = getCreditCost(toolId);
  const monthlyRemaining = Math.max(0, plan.creditsPerMonth - creditsUsed);
  const addOnCreditsRemaining = getActiveAddOnCredits(req.userId);
  const availableCredits = monthlyRemaining + addOnCreditsRemaining;

  if (availableCredits < cost) {
    return res.status(429).json({
      error:
        `Not enough allowance units. This request requires ${cost} allowance units. You currently have ${availableCredits} remaining. Your allowance renews on your next billing date.`,
      code: "ALLOWANCE_EXHAUSTED",
      remaining: availableCredits,
      monthlyRemaining,
      addOnCreditsRemaining,
    });
  }

  req.creditsUsed = creditsUsed;
  req.creditCostForTool = cost;
  req.monthlyRemaining = monthlyRemaining;
  req.addOnCreditsRemaining = addOnCreditsRemaining;
  req.availableCredits = availableCredits;
  next();
}
