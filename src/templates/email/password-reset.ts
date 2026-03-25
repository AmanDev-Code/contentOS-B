/**
 * Password Reset template - sent when users request a password reset
 */
import { wrapEmail } from './_base';

export function getPasswordResetTemplate(resetUrl: string): string {
  const content = `
    <h1 class="title">Reset your password</h1>
    <p class="text">We received a request to reset the password for your Trndinn account. Click the button below to create a new password.</p>
    <p class="text" style="margin-bottom: 28px;">
      <a href="${resetUrl}" class="button">Reset Password</a>
    </p>
    <div class="divider"></div>
    <p class="text" style="font-size: 14px; margin-bottom: 12px;">If the button does not work, copy and paste this link into your browser:</p>
    <p class="text" style="font-size: 13px; word-break: break-all;"><a href="${resetUrl}" class="link">${resetUrl}</a></p>
    <p class="text" style="font-size: 13px; color: #71717a; margin-top: 24px;">This link expires in 1 hour. If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>
  `;
  return wrapEmail(content, 'Reset Your Password - Trndinn');
}
