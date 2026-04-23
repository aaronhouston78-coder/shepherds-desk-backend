// ─── PLAN AND CREDIT CONFIGURATION ───────────────────────────────────────────
// Single source of truth for all plan definitions, credit costs, and
// output word limits per tool.
//
// CREDIT SYSTEM DESIGN:
//   Credits are the usage currency. Each tool costs a set number of credits.
//   Paid plans receive a monthly credit allowance that resets on the 1st.
//   Owner accounts bypass all credit checks entirely.
//   Trial is removed as a default path — new users are prompted to subscribe.
//
// OUTPUT WORD LIMITS:
//   Hard caps enforced server-side in aiService.js.
//   Sermon: 1,500 words max (framework for a full message)
//   Bible study: 1,000 words max
//   Caption: 60–120 words
//   Follow-up: 90–150 words
//   Announcement: 125–210 words

export const PLANS = {
  // ── Pending: new registrations before subscribing ───────────────────────────
  // Users land here after signup. planEnforcement blocks generation.
  // Settings page shows the subscribe UI. No generation access.
  // Replaced "trial" — pending is honest: they registered but haven't paid yet.
  pending: {
    id:              "pending",
    label:           "Pending",
    price:           0,
    creditsPerMonth: 0,
    features: { savedGenerations: false, savedTemplates: false, teamAccess: false },
  },

  // ── Paid tiers ──────────────────────────────────────────────────────────────
  starter: {
    id:              "starter",
    label:           "Starter",
    price:           19,
    currency:        "usd",
    interval:        "month",
    // 8 sermons OR ~32 short-form pieces per month
    creditsPerMonth: 32,
    features: {
      savedGenerations: true,
      savedTemplates:   false,
      teamAccess:       false,
    },
  },
  growth: {
    id:              "growth",
    label:           "Growth",
    price:           49,
    currency:        "usd",
    interval:        "month",
    // 25 sermons OR ~100 short-form pieces per month
    creditsPerMonth: 100,
    features: {
      savedGenerations: true,
      savedTemplates:   true,
      teamAccess:       false,
    },
  },
  team: {
    id:              "team",
    label:           "Church Team",
    price:           99,
    currency:        "usd",
    interval:        "month",
    // 50 sermons OR ~200 short-form pieces per month
    creditsPerMonth: 200,
    features: {
      savedGenerations: true,
      savedTemplates:   true,
      teamAccess:       true,
    },
  },

  // ── Owner plan ───────────────────────────────────────────────────────────────
  // Assigned to the product owner. Bypasses all credit and billing checks.
  // Never shown to subscribers. Set via DB: UPDATE users SET plan='owner', is_owner=1
  owner: {
    id:              "owner",
    label:           "Owner",
    price:           0,
    creditsPerMonth: 999999,
    features: {
      savedGenerations: true,
      savedTemplates:   true,
      teamAccess:       true,
    },
  },
};

// ── Stripe price IDs ──────────────────────────────────────────────────────────
// Set these in backend/.env after creating products in your Stripe dashboard.
// Each corresponds to a recurring monthly price for that plan.
// Example: STRIPE_PRICE_STARTER=price_1ABC...
export function getStripePriceId(planId) {
  const map = {
    starter: process.env.STRIPE_PRICE_STARTER,
    growth:  process.env.STRIPE_PRICE_GROWTH,
    team:    process.env.STRIPE_PRICE_TEAM,
  };
  return map[planId] ?? null;
}

// ── Tool credit costs ─────────────────────────────────────────────────────────
// One credit = one generation unit.
// Costs reflect API expense and output complexity.
export const TOOL_CREDIT_COSTS = {
  "sermon":       4,
  "bible-study":  3,
  "announcement": 1,
  "caption":      1,
  "follow-up":    1,
};

export const DEFAULT_CREDIT_COST = 2;
export const VALID_PLAN_IDS      = Object.keys(PLANS);
export const DEFAULT_PLAN        = "pending"; // new accounts — must subscribe to generate

// ── Tool output word limits ───────────────────────────────────────────────────
// These are the maximum word counts returned to the client.
// Enforced server-side in aiService.js processOutput().
export const TOOL_OUTPUT_LIMITS = {
  "sermon":       1500,
  "bible-study":  1000,
  "caption":      120,
  "follow-up":    150,
  "announcement": 210,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getPlan(planId) {
  return PLANS[planId] ?? PLANS.starter;
}

export function getCreditCost(toolId) {
  return TOOL_CREDIT_COSTS[toolId] ?? DEFAULT_CREDIT_COST;
}

export function hasEnoughCredits(planId, creditsUsed, toolId) {
  // Owner bypasses all credit checks
  if (planId === "owner") return true;
  const plan = getPlan(planId);
  const cost = getCreditCost(toolId);
  return (creditsUsed + cost) <= plan.creditsPerMonth;
}

export function remainingCredits(planId, creditsUsed) {
  if (planId === "owner") return 999999;
  return Math.max(0, getPlan(planId).creditsPerMonth - creditsUsed);
}

export function getOutputWordLimit(toolId) {
  return TOOL_OUTPUT_LIMITS[toolId] ?? 500;
}
