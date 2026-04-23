import "dotenv/config";
import express          from "express";
import cors             from "cors";
import { mkdirSync }    from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { globalLimiter } from "./middleware/rateLimiter.js";
import authRoutes       from "./routes/auth.js";
import generatorRoutes  from "./routes/generators.js";
import adminRoutes      from "./routes/admin.js";
import billingRoutes    from "./routes/billing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_PROD   = process.env.NODE_ENV === "production";

mkdirSync(join(__dirname, "data"), { recursive: true });

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Security headers ──────────────────────────────────────────────────────────
try {
  const { default: helmet } = await import("helmet");
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'"],
        styleSrc:   ["'self'", "'unsafe-inline'"],
        imgSrc:     ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameSrc:   ["'none'"],
        objectSrc:  ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
} catch {
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options":    "nosniff",
      "X-Frame-Options":           "DENY",
      "X-XSS-Protection":          "0",
      "Referrer-Policy":           "no-referrer",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "Permissions-Policy":        "camera=(), microphone=(), geolocation=()",
    });
    next();
  });
}

// ── CORS ──────────────────────────────────────────────────────────────────────
const CONFIGURED_ORIGIN = process.env.FRONTEND_URL || "";

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      if (IS_PROD) return callback(new Error("CORS: origin required in production"));
      return callback(null, true);
    }
    if (CONFIGURED_ORIGIN && origin === CONFIGURED_ORIGIN) return callback(null, true);
    if (!IS_PROD && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    callback(new Error("CORS: origin not allowed"));
  },
  credentials: true,
  optionsSuccessStatus: 200,
}));

// ── Webhook route — MUST come before express.json() ───────────────────────────
// Stripe requires the raw request body to verify the webhook signature.
// Registering this route first, before the JSON body parser, ensures the
// raw buffer is available in req.body for the webhook handler.
app.use(
  "/api/billing/webhook",
  express.raw({ type: "application/json" }),
  (req, _res, next) => {
    // Keep the raw buffer as req.body — billingRoutes webhook handler reads it directly
    next();
  }
);

// ── Body parser ───────────────────────────────────────────────────────────────
// All other routes receive parsed JSON
app.use(express.json({ limit: "16kb" }));

app.disable("x-powered-by");
app.use(globalLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth",       authRoutes);
app.use("/api/billing",    billingRoutes);
app.use("/api/admin",      adminRoutes);
app.use("/api/generators", generatorRoutes);

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.use((_req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.use((err, _req, res, _next) => {
  const reqId = res.locals.requestId ?? "-";
  console.error(`[error] req=${reqId}`, IS_PROD ? err.message : err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

app.listen(PORT, () => {
  const keyStatus    = process.env.ANTHROPIC_API_KEY ? "set" : "NOT SET";
  const stripeStatus = process.env.STRIPE_SECRET_KEY ? "set" : "not set — billing disabled";
  console.log(`Shepherd's Desk API listening on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV ?? "development"}`);
  console.log(`API key:     ${keyStatus}`);
  console.log(`Stripe key:  ${stripeStatus}`);
  if (!IS_PROD) {
    console.log(`FRONTEND_URL: ${CONFIGURED_ORIGIN || "(not set — localhost allowed)"}`);
  }
});
