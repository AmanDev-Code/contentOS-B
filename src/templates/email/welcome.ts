/**
 * Welcome template - sent after email verification
 */
import { wrapEmail } from './_base';

export function getWelcomeTemplate(userName: string, dashboardUrl: string): string {
  const displayName = userName || 'there';
  const content = `
    <h1 class="title">Welcome, ${displayName}</h1>
    <p class="text">Your email has been verified. You are now part of a community that is revolutionizing content creation with AI.</p>
    <p class="text">Here is how to get started:</p>
    <p class="text" style="margin: 24px 0 12px; padding-left: 20px; border-left: 3px solid #e4e4e7;">
      <strong>1. Complete your profile</strong><br>
      <span style="color: #71717a; font-size: 14px;">Connect your LinkedIn account for seamless posting.</span>
    </p>
    <p class="text" style="margin: 12px 0; padding-left: 20px; border-left: 3px solid #e4e4e7;">
      <strong>2. Generate your first post</strong><br>
      <span style="color: #71717a; font-size: 14px;">Use Find Viral Topic to discover trending content ideas.</span>
    </p>
    <p class="text" style="margin: 12px 0 28px; padding-left: 20px; border-left: 3px solid #e4e4e7;">
      <strong>3. Schedule or publish</strong><br>
      <span style="color: #71717a; font-size: 14px;">Post immediately or schedule for optimal engagement.</span>
    </p>
    <p class="text" style="margin-bottom: 28px;">
      <a href="${dashboardUrl}" class="button">Go to Dashboard</a>
    </p>
    <p class="text" style="font-size: 14px; color: #71717a;">Need help getting started? Reach out to our support team anytime.</p>
  `;
  return wrapEmail(content, 'Welcome to Postra');
}
