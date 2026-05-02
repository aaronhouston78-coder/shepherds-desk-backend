import { getDb } from "../db/database.js";

export function getActiveAddOnCredits(userId) {
  const db = getDb();

  const row = db.prepare(`
    SELECT COALESCE(SUM(credits_purchased - credits_used), 0) AS total
    FROM credit_purchases
    WHERE user_id = ?
      AND datetime(expires_at) > datetime('now')
      AND credits_used < credits_purchased
  `).get(userId);

  return row?.total ?? 0;
}

export function deductAddOnCredits(userId, creditsToDeduct) {
  let remainingToDeduct = creditsToDeduct;

  if (remainingToDeduct <= 0) return;

  const db = getDb();

  const purchases = db.prepare(`
    SELECT id, credits_purchased, credits_used
    FROM credit_purchases
    WHERE user_id = ?
      AND datetime(expires_at) > datetime('now')
      AND credits_used < credits_purchased
    ORDER BY datetime(expires_at) ASC, datetime(created_at) ASC
  `).all(userId);

  const update = db.prepare(`
    UPDATE credit_purchases
    SET credits_used = credits_used + ?
    WHERE id = ?
  `);

  const transaction = db.transaction(() => {
    for (const purchase of purchases) {
      if (remainingToDeduct <= 0) break;

      const available = purchase.credits_purchased - purchase.credits_used;
      const deduction = Math.min(available, remainingToDeduct);

      update.run(deduction, purchase.id);
      remainingToDeduct -= deduction;
    }

    if (remainingToDeduct > 0) {
      throw new Error("Not enough add-on credits available.");
    }
  });

  transaction();
}
