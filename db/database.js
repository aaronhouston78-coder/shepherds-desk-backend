import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.SD_TEST_DB ?? join(__dirname, "../data/shepherds_desk.db");

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      email             TEXT NOT NULL UNIQUE,
      password          TEXT NOT NULL,
      church_name       TEXT,
      role              TEXT,
      plan              TEXT NOT NULL DEFAULT 'starter',
      -- Owner/admin bypass: owner accounts are never blocked by billing or credit limits
      is_owner          INTEGER NOT NULL DEFAULT 0,
      -- Email verification
      email_verified    INTEGER NOT NULL DEFAULT 0,
      verify_token      TEXT,
      verify_expires    TEXT,
      -- Trial tracking
      trial_credits_used INTEGER NOT NULL DEFAULT 0,
      reg_fingerprint   TEXT,
      -- Stripe
      stripe_customer_id  TEXT,
      stripe_sub_id       TEXT,
      stripe_sub_status   TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS saved_generations (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tool_id     TEXT NOT NULL,
      tool_label  TEXT NOT NULL,
      title       TEXT NOT NULL,
      form_data   TEXT NOT NULL,
      output      TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS saved_templates (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tool_id     TEXT NOT NULL,
      tool_label  TEXT NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      form_data   TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type   TEXT NOT NULL DEFAULT 'generation',
      tool_id      TEXT NOT NULL,
      credits_used INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fingerprint_registry (
      fingerprint        TEXT PRIMARY KEY,
      total_credits_used INTEGER NOT NULL DEFAULT 0,
      first_seen         TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_gen_user    ON saved_generations(user_id);
    CREATE INDEX IF NOT EXISTS idx_tpl_user    ON saved_templates(user_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_usage_user  ON usage_events(user_id);
    CREATE INDEX IF NOT EXISTS idx_usage_month ON usage_events(user_id, event_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_users_fp    ON users(reg_fingerprint);
  `);

  // Auto-migration: add columns that may not exist in older databases
  const cols = db.prepare("PRAGMA table_info(users)").all().map(r => r.name);
  const migrations = [
    ["email_verified",      "ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0"],
    ["verify_token",        "ALTER TABLE users ADD COLUMN verify_token TEXT"],
    ["verify_expires",      "ALTER TABLE users ADD COLUMN verify_expires TEXT"],
    ["trial_credits_used",  "ALTER TABLE users ADD COLUMN trial_credits_used INTEGER NOT NULL DEFAULT 0"],
    ["reg_fingerprint",     "ALTER TABLE users ADD COLUMN reg_fingerprint TEXT"],
    ["is_owner",            "ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0"],
    ["stripe_customer_id",  "ALTER TABLE users ADD COLUMN stripe_customer_id TEXT"],
    ["stripe_sub_id",       "ALTER TABLE users ADD COLUMN stripe_sub_id TEXT"],
    ["stripe_sub_status",   "ALTER TABLE users ADD COLUMN stripe_sub_status TEXT"],
  ];
  for (const [col, sql] of migrations) {
    if (!cols.includes(col)) db.prepare(sql).run();
  }

  db.exec(`CREATE TABLE IF NOT EXISTS fingerprint_registry (
    fingerprint        TEXT PRIMARY KEY,
    total_credits_used INTEGER NOT NULL DEFAULT 0,
    first_seen         TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen          TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}
