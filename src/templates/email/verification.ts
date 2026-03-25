/**
 * Email Verification template - OTP code sent to new users to verify their email
 */
import { wrapEmail } from './_base';

export function getVerificationTemplate(otp: string): string {
  const content = `
    <h1 class="title">Verify your email address</h1>
    <p class="text">Thank you for signing up for Trndinn. Enter the code below to verify your email and access your dashboard.</p>
    <div style="text-align: center; margin: 32px 0;">
      <div style="display: inline-block; background-color: #f4f4f5; border: 2px solid #e4e4e7; border-radius: 8px; padding: 20px 40px; letter-spacing: 8px; font-size: 32px; font-weight: 700; color: #18181b; font-family: 'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', monospace;">${otp}</div>
    </div>
    <p class="text" style="text-align: center; font-size: 14px; color: #71717a;">This code expires in 10 minutes.</p>
    <div class="divider"></div>
    <p class="text" style="font-size: 13px; color: #71717a;">If you did not create an account with Trndinn, you can safely ignore this email.</p>
  `;
  return wrapEmail(content, 'Verify Your Email - Trndinn');
}
