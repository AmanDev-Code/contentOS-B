/**
 * Shared base styles and layout for all email templates.
 * Professional, modular design without emojis.
 */
export const BASE_STYLES = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif; margin: 0; padding: 0; background-color: #f4f4f5; line-height: 1.6; color: #3f3f46; }
  .wrapper { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
  .header { padding: 32px 40px 28px; border-bottom: 1px solid #e4e4e7; }
  .logo { font-size: 22px; font-weight: 600; color: #18181b; letter-spacing: -0.02em; }
  .header-tagline { font-size: 13px; color: #71717a; margin-top: 4px; }
  .content { padding: 36px 40px 40px; }
  .title { font-size: 20px; font-weight: 600; color: #18181b; margin: 0 0 16px; letter-spacing: -0.01em; }
  .text { font-size: 15px; color: #52525b; margin: 0 0 20px; }
  .button { display: inline-block; background-color: #18181b; color: #ffffff !important; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-weight: 500; font-size: 15px; }
  .button:hover { background-color: #27272a; }
  .divider { height: 1px; background-color: #e4e4e7; margin: 28px 0; }
  .footer { padding: 24px 40px; background-color: #fafafa; border-top: 1px solid #e4e4e7; text-align: center; font-size: 12px; color: #71717a; }
  .footer a { color: #52525b; text-decoration: none; }
  .link { color: #18181b; text-decoration: underline; }
  @media (max-width: 600px) {
    .header, .content, .footer { padding-left: 24px; padding-right: 24px; }
    .content { padding-top: 28px; padding-bottom: 32px; }
  }
`;

export function wrapEmail(content: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>${BASE_STYLES}</style>
</head>
<body style="margin:0;padding:0;">
  <div class="wrapper">
    <div class="header">
      <div class="logo">Trndinn</div>
      <div class="header-tagline">AI-Powered Content Creation Platform</div>
    </div>
    <div class="content">
      ${content}
    </div>
    <div class="footer">
      <p style="margin:0 0 8px;">© 2026 Trndinn. All rights reserved.</p>
      <p style="margin:0;"><a href="mailto:support@trndinn.com">support@trndinn.com</a></p>
    </div>
  </div>
</body>
</html>`;
}
