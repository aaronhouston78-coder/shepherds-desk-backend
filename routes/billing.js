// ─── BILLING ROUTES ───────────────────────────────────────────────────────────
// Stripe Checkout and webhook handling.
//
// Flow:
//   1. Logged-in user clicks Subscribe for a plan.
//   2. Frontend calls POST /api/billing/checkout with { planId }.
//   3. Backend creates a Stripe Checkout Session and returns { url }.
//   4. Frontend redirects to url (Stripe-hosted page).
//   5. After payment, Stripe redirects to FRONTEND_URL/billing/success.
//   6. Stripe also sends a webhook event to POST /api/billing/webhook.
//   7. Webhook handler verifies signature, reads event, updates user.plan in DB.
//
// Owner accounts are never sent through checkout.
// Trial accounts can check out for any paid plan.
// Existing paid subscribers are redirected to the Stripe customer portal to
// upgrade, downgrade, or cancel (POST /api/billing/portal).
//
// Required environment variables:
//   STRIPE_SECRET_KEY       — sk_live_... or sk_test_...
//   STRIPE_WEBHOOK_SECRET   — whsec_... (from Stripe dashboard webhook settings)
//   STRIPE_PRICE_STARTER    — price_... for the $19/mo Starter product
//   STRIPE_PRICE_GROWTH     — price_... for the $49/mo Growth product
//   STRIPE_PRICE_TEAM       — price_... for the $99/mo Church Team product
//   FRONTEND_URL            — your deployed frontend origin (already required)

import { Router }   from "express";
import { requireAuth } from "../middleware/auth.js";
import { getDb }    from "../db/database.js";
import { getPlan, getStripePriceId, VALID_PLAN_IDS } from "../config/plans.js";

const router = Router();

// ── Stripe client ─────────────────────────────────────────────────────────────
// Lazy — only initialised when a billing route is actually called.
// If STRIPE_SECRET_KEY is not set, billing routes return a clear error.
let _stripe = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }
  if (!_stripe) {
    // Dynamic import so the module can load even before npm install runs
    const Stripe = require("stripe"); // CommonJS fallback for stripe v14
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
  }
  return _stripe;
}

// Stripe v14 ships as CJS — use createRequire to import from ESM
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const APP_URL = () => process.env.FRONTEND_URL || "http://localhost:5173";

// ── POST /checkout ────────────────────────────────────────────────────────────
// Creates a Stripe Checkout session for a new subscription.
// Returns { url } — frontend redirects the user there.

router.post("/checkout", requireAuth, async (req, res) => {
  const { planId } = req.body;

  if (!planId || !["starter", "growth", "team"].includes(planId)) {
    return res.status(400).json({ error: "Invalid plan selected." });
  }

  // Owner accounts never go through checkout
  if (req.isOwner || req.userPlan === "owner") {
    return res.status(400).json({ error: "Owner accounts do not require a subscription." });
  }

  const priceId = getStripePriceId(planId);
  if (!priceId) {
    return res.status(500).json({
      error: "This plan is not yet configured for checkout. Please contact support.",
    });
  }

  const db   = getDb();
  const user = db.prepare("SELECT id, name, email, stripe_customer_id FROM users WHERE id = ?").get(req.userId);
  if (!user) return res.status(404).json({ error: "User not found." });

  let stripe;
  try { stripe = getStripe(); } catch {
    return res.status(500).json({ error: "Billing is not yet configured. Please contact support." });
  }

  try {
    // Re-use existing Stripe customer if we already created one for this user
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name:  user.name,
        metadata: { userId: user.id },
      });
      customerId = customer.id;
      db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode:        "subscription",
      customer:    customerId,
      line_items:  [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL()}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${APP_URL()}/billing/cancel`,
      metadata:    { userId: user.id, planId },
      subscription_data: {
        metadata: { userId: user.id, planId },
      },
      // Collect tax automatically if you enable Stripe Tax later
      // automatic_tax: { enabled: true },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("[billing/checkout] Stripe error:", err?.message);
    return res.status(500).json({ error: "Could not create checkout session. Please try again." });
  }
});

// ── POST /portal ──────────────────────────────────────────────────────────────
// Opens the Stripe Customer Portal for an existing subscriber.
// Used for plan changes, cancellation, and invoice history.

router.post("/portal", requireAuth, async (req, res) => {
  if (req.isOwner || req.userPlan === "owner") {
    return res.status(400).json({ error: "Owner accounts do not have a billing portal." });
  }

  const db   = getDb();
  const user = db.prepare("SELECT stripe_customer_id FROM users WHERE id = ?").get(req.userId);

  if (!user?.stripe_customer_id) {
    return res.status(400).json({
      error: "No billing account found. Please subscribe first.",
    });
  }

  let stripe;
  try { stripe = getStripe(); } catch {
    return res.status(500).json({ error: "Billing is not configured. Please contact support." });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripe_customer_id,
      return_url: `${APP_URL()}/settings`,
    });
    return res.json({ url: session.url });
  } catch (err) {
    console.error("[billing/portal] Stripe error:", err?.message);
    return res.status(500).json({ error: "Could not open billing portal. Please try again." });
  }
});

// ── POST /webhook ─────────────────────────────────────────────────────────────
// Receives Stripe webhook events.
// IMPORTANT: This route must receive the RAW request body (not JSON-parsed).
// server.js registers this route BEFORE express.json() using express.raw().
//
// Events handled:
//   customer.subscription.created   → set user.plan to the subscribed plan
//   customer.subscription.updated   → update plan if it changed
//   customer.subscription.deleted   → reset user.plan to 'trial' (access revoked)
//   checkout.session.completed      → fallback activation if subscription event missed

router.post("/webhook", async (req, res) => {
  const sig    = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error("[billing/webhook] STRIPE_WEBHOOK_SECRET not set");
    return res.status(500).send("Webhook secret not configured.");
  }

  let stripe;
  try { stripe = getStripe(); } catch {
    return res.status(500).send("Stripe not configured.");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("[billing/webhook] Signature verification failed:", err?.message);
    return res.status(400).send(`Webhook error: ${err?.message}`);
  }

  const db = getDb();

  try {
    switch (event.type) {

      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode !== "subscription") break;
        const userId = session.metadata?.userId;
        const planId = session.metadata?.planId;
        if (userId && planId) {
          db.prepare(
            "UPDATE users SET plan = ?, stripe_sub_id = ?, stripe_sub_status = 'active', updated_at = datetime('now') WHERE id = ?"
          ).run(planId, session.subscription, userId);
          console.log(`[billing] checkout.session.completed → user ${userId} → plan ${planId}`);
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub    = event.data.object;
        const userId = sub.metadata?.userId;
        const planId = sub.metadata?.planId ?? resolvedPlanFromSub(sub);
        const status = sub.status; // active | past_due | canceled | etc.

        if (!userId) {
          // Look up user by stripe_customer_id as a fallback
          const user = db.prepare("SELECT id FROM users WHERE stripe_customer_id = ?").get(sub.customer);
          if (user) {
            const resolvedPlan = planId ?? resolvedPlanFromPriceId(sub, db);
            db.prepare(
              "UPDATE users SET plan = ?, stripe_sub_id = ?, stripe_sub_status = ?, updated_at = datetime('now') WHERE id = ?"
            ).run(resolvedPlan || "starter", sub.id, status, user.id);
            console.log(`[billing] ${event.type} → user ${user.id} → plan ${resolvedPlan} status ${status}`);
          }
          break;
        }

        const effectivePlan = status === "active" || status === "trialing"
          ? (planId ?? "starter")
          : "pending"; // past_due or incomplete — revoke generation access

        db.prepare(
          "UPDATE users SET plan = ?, stripe_sub_id = ?, stripe_sub_status = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(effectivePlan, sub.id, status, userId);
        console.log(`[billing] ${event.type} → user ${userId} → plan ${effectivePlan} status ${status}`);
        break;
      }

      case "customer.subscription.deleted": {
        const sub    = event.data.object;
        const userId = sub.metadata?.userId;

        if (userId) {
          db.prepare(
            "UPDATE users SET plan = 'pending', stripe_sub_status = 'canceled', updated_at = datetime('now') WHERE id = ?"
          ).run(userId);
          console.log(`[billing] subscription.deleted → user ${userId} → access revoked`);
        } else {
          // Fallback: find by customer ID
          const user = db.prepare("SELECT id FROM users WHERE stripe_customer_id = ?").get(sub.customer);
          if (user) {
            db.prepare(
              "UPDATE users SET plan = 'pending', stripe_sub_status = 'canceled', updated_at = datetime('now') WHERE id = ?"
            ).run(user.id);
            console.log(`[billing] subscription.deleted → user ${user.id} (by customer id) → access revoked`);
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        // Log for monitoring — access is not immediately revoked on first failure
        // Stripe will retry. subscription.updated with status=past_due will follow
        // if retries exhaust.
        const invoice = event.data.object;
        console.warn(`[billing] invoice.payment_failed → customer ${invoice.customer}`);
        break;
      }

      default:
        // Unhandled event type — log and acknowledge
        console.log(`[billing] Unhandled webhook event: ${event.type}`);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("[billing/webhook] Handler error:", err?.message);
    return res.status(500).json({ error: "Webhook processing failed." });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Attempt to resolve a plan ID from a subscription's price ID
// by matching against the STRIPE_PRICE_* env vars.
function resolvedPlanFromSub(sub) {
  const priceId = sub.items?.data?.[0]?.price?.id;
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_STARTER) return "starter";
  if (priceId === process.env.STRIPE_PRICE_GROWTH)  return "growth";
  if (priceId === process.env.STRIPE_PRICE_TEAM)    return "team";
  return null;
}

export default router;
