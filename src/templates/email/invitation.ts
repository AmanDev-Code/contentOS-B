/**
 * User Invitation template - sent to invite new users to the platform
 */
import { wrapEmail } from './_base';

export function getInvitationTemplate(inviterName: string, inviteUrl: string): string {
  const content = `
    <h1 class="title">You are invited to join Trndinn</h1>
    <p class="text"><strong>${inviterName}</strong> has invited you to join Trndinn, an AI-powered content creation platform.</p>
    <p class="text">Trndinn helps creators generate engaging content for LinkedIn and other social platforms. Join thousands of users who are already using AI to grow their audience.</p>
    <p class="text" style="margin-bottom: 28px;">
      <a href="${inviteUrl}" class="button">Accept Invitation</a>
    </p>
    <div class="divider"></div>
    <p class="text" style="font-size: 14px; margin-bottom: 12px;">If the button does not work, copy and paste this link into your browser:</p>
    <p class="text" style="font-size: 13px; word-break: break-all;"><a href="${inviteUrl}" class="link">${inviteUrl}</a></p>
    <p class="text" style="font-size: 13px; color: #71717a; margin-top: 24px;">This invitation expires in 7 days. If you are not interested, you can safely ignore this email.</p>
  `;
  return wrapEmail(content, 'Invitation to Trndinn');
}
