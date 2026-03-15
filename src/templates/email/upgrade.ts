/**
 * Account Upgrade template - sent when users upgrade their subscription
 */
import { wrapEmail } from './_base';

export function getUpgradeTemplate(planName: string, amount: number): string {
  const content = `
    <h1 class="title">Account upgraded successfully</h1>
    <p class="text">Your Postra account has been upgraded to <strong>${planName}</strong>. You now have access to premium features and increased limits.</p>
    <div style="background-color: #f4f4f5; border-radius: 6px; padding: 24px; margin: 28px 0;">
      <p style="margin: 0 0 8px; font-size: 13px; color: #71717a;">Upgrade summary</p>
      <p style="margin: 0; font-size: 18px; font-weight: 600;">${planName} — $${amount.toFixed(2)}</p>
    </div>
    <p class="text">What is included:</p>
    <ul style="margin: 16px 0 28px; padding-left: 24px; color: #52525b; font-size: 15px; line-height: 1.8;">
      <li>Increased AI credit limits</li>
      <li>Priority content generation</li>
      <li>Advanced scheduling features</li>
      <li>Premium support</li>
    </ul>
    <p class="text" style="font-size: 14px; color: #71717a;">Your new features are active now. Log in to your dashboard to start exploring.</p>
  `;
  return wrapEmail(content, 'Account Upgraded - Postra');
}
