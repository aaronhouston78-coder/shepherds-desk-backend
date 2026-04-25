// ─── EMAIL SERVICE ────────────────────────────────────────────────────────────
// Sends transactional emails through Resend.
// Requires one environment variable: RESEND_API_KEY
//
// To activate email sending:
//   1. Sign up at https://resend.com (free tier: 3,000 emails/month)
//   2. Add a verified sender domain in the Resend dashboard
//   3. Set RESEND_API_KEY=re_xxxx in backend/.env
//   4. Set EMAIL_FROM=noreply@yourdomain.com in backend/.env
//
// If RESEND_API_KEY is not set, this service operates in dev mode:
// it logs the email to the console instead of sending it.
// This means local development works without a provider configured.

const DEV_MODE = !process.env.RESEND_API_KEY;
console.log("[emailService startup] RESEND_API_KEY present:", !!process.env.RESEND_API_KEY);
console.log("[emailService startup] EMAIL_FROM:", process.env.EMAIL_FROM || "(missing)");
console.log("[emailService startup] FRONTEND_URL:", process.env.FRONTEND_URL || "(missing)");


let _resend = null;
async function getResend() {
  if (!_resend) {
    const { Resend } = await import("resend");
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

const FROM = process.env.EMAIL_FROM || "Shepherd's Desk <noreply@shepherdsdesk.app>";
const APP_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// ── Send email verification ───────────────────────────────────────────────────

export async function sendVerificationEmail(to, name, token) {
  const verifyUrl = `${APP_URL}/verify-email?token=${token}`;

  if (DEV_MODE) {
    console.log("\n[emailService DEV MODE] Verification email would be sent:");
    console.log(`  To:    ${to}`);
    console.log(`  Name:  ${name}`);
    console.log(`  URL:   ${verifyUrl}\n`);
    return { success: true, dev: true };
  }

  try {
    const resend = await getResend();
    await resend.emails.send({
      from:    FROM,
      to:      [to],
      subject: "Verify your Shepherd's Desk account",
      html: buildVerificationHtml(name, verifyUrl),
      text: buildVerificationText(name, verifyUrl),
    });
    return { success: true };
  } catch (err) {
    console.error("[emailService] Failed to send verification email:", err?.message ?? err);
    return { success: false };
  }
}

// ── Email templates ───────────────────────────────────────────────────────────

function buildVerificationHtml(name, url) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#F4F2EE;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F4F2EE;padding:40px 20px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">
        <tr><td style="background:#1B2B4B;padding:24px 32px;">
          <p style="margin:0;font-size:20px;font-weight:700;color:#C9A84C;letter-spacing:-0.5px;">Shepherd's Desk</p>
        </td></tr>
        <tr><td style="padding:36px 32px;">
          <h1 style="margin:0 0 12px;font-size:24px;font-weight:700;color:#1B2B4B;">Verify your email address</h1>
          <p style="margin:0 0 24px;font-size:15px;color:#6B6050;line-height:1.6;">
            Hello ${name},<br><br>
            Thank you for creating your Shepherd's Desk account. Click the button below to verify your email address and activate your free trial.
          </p>
          <a href="${url}" style="display:inline-block;background:#1B2B4B;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600;">
            Verify Email Address
          </a>
          <p style="margin:24px 0 0;font-size:13px;color:#A09880;line-height:1.6;">
            This link expires in 24 hours. If you did not create this account, you can safely ignore this email.
          </p>
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #E8E4DC;">
          <p style="margin:0;font-size:12px;color:#A09880;">
            If the button above does not work, copy and paste this link:<br>
            <a href="${url}" style="color:#1B2B4B;">${url}</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildVerificationText(name, url) {
  return `Hello ${name},

Verify your Shepherd's Desk account by visiting this link:

${url}

This link expires in 24 hours.

If you did not create this account, ignore this email.

— Shepherd's Desk`;
}
