import "dotenv/config";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "Shepherd's Desk <noreply@theshepherdsdesk.org>";
const APP_URL = (process.env.FRONTEND_URL || "https://theshepherdsdesk.org")
  .replace(/^FRONTEND_URL=/, "")
  .replace(/\/$/, "");

console.log("[emailService startup] RESEND_API_KEY present:", !!RESEND_API_KEY);
console.log("[emailService startup] EMAIL_FROM:", EMAIL_FROM);
console.log("[emailService startup] FRONTEND_URL:", APP_URL);

async function getResend() {
  if (!RESEND_API_KEY) return null;

  const { Resend } = await import("resend");
  return new Resend(RESEND_API_KEY);
}

export async function sendVerificationEmail(to, name, token) {
  const verifyUrl = `${APP_URL}/verify-email?token=${token}`;
  const displayName = name || "there";

  const subject = "Verify your Shepherd's Desk email address";

  const html = `
  <div style="font-family: Arial, sans-serif; background:#f7f5ef; padding:30px;">
    <div style="max-width:600px; margin:0 auto; background:#ffffff; padding:36px; border-radius:10px;">
      <h1 style="color:#1B2B4B; font-size:32px; margin-bottom:24px;">Verify your email address</h1>

      <p style="font-size:18px; color:#6b6258; line-height:1.6;">Hello ${displayName},</p>

      <p style="font-size:18px; color:#6b6258; line-height:1.6;">
        Thank you for creating your Shepherd's Desk account. Click the button below to verify your email address and complete your account setup.
      </p>

      <p style="margin:32px 0;">
        <a href="${verifyUrl}" style="background:#1B2B4B; color:#ffffff; padding:14px 26px; text-decoration:none; border-radius:6px; font-size:18px; font-weight:bold; display:inline-block;">
          Verify Email Address
        </a>
      </p>

      <p style="font-size:16px; color:#9a9288; line-height:1.6;">
        This link expires in 24 hours. If you did not create this account, you can safely ignore this email.
      </p>

      <hr style="border:none; border-top:1px solid #eee; margin:30px 0;" />

      <p style="font-size:14px; color:#9a9288; line-height:1.5;">
        If the button above does not work, copy and paste this link:<br />
        <span style="color:#1B2B4B; word-break:break-all;">${verifyUrl}</span>
      </p>
    </div>
  </div>
  `;

  const text = `
Hello ${displayName},

Thank you for creating your Shepherd's Desk account. Verify your email address and complete your account setup here:

${verifyUrl}

This link expires in 24 hours.
`;

  const resend = await getResend();

  if (!resend) {
    console.log("[emailService DEV MODE] Verification email would be sent:");
    console.log("To:", to);
    console.log("Name:", displayName);
    console.log("URL:", verifyUrl);
    return { success: true, dev: true };
  }

  await resend.emails.send({
    from: EMAIL_FROM,
    to,
    subject,
    html,
    text,
  });

  return { success: true };
}
