// ─── CREDIT ENFORCEMENT MIDDLEWARE ───────────────────────────────────────────
// Owner accounts bypass all credit checks.
// Paid accounts are checked against monthly usage.
// Trial plan no longer exists as a default — existing trial rows are treated
// as zero-credit accounts that require an upgrade.

import { getDb }                                        from "../db/database.js";
import { hasEnoughCredits, getCreditCost, remainingCredits } from "../config/plans.js";

export function enforceCreditLimit(req, res, next) {
  return next();

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

  if (!hasEnoughCredits(planId, creditsUsed, toolId)) {
    const cost      = getCreditCost(toolId);
    const remaining = remainingCredits(planId, creditsUsed);
    return res.status(429).json({
      error: remaining === 0
        ? "You have used all credits for this month. Your allowance resets on the 1st."
        : `This tool requires ${cost} credit${cost !== 1 ? "s" : ""} and you have ${remaining} remaining this month.`,
      code: "CREDITS_EXHAUSTED",
      remaining,
    });
  }

  req.creditsUsed       = creditsUsed;
  req.creditCostForTool = getCreditCost(toolId);
  next();
}
