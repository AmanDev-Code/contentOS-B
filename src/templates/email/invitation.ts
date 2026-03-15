/**
 * User Invitation template - sent to invite new users to the platform
 */
export function getInvitationTemplate(inviterName: string, inviteUrl: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>You're Invited to Postra</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc; }
        .container { max-width: 600px; margin: 0 auto; background-color: white; }
        .header { background: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%); padding: 40px 30px; text-align: center; }
        .logo { color: #2d3748; font-size: 28px; font-weight: bold; margin-bottom: 10px; }
        .content { padding: 40px 30px; }
        .title { font-size: 24px; font-weight: 600; color: #1a202c; margin-bottom: 20px; }
        .text { color: #4a5568; line-height: 1.6; margin-bottom: 30px; }
        .button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-weight: 600; margin: 20px 0; }
        .inviter { background-color: #edf2f7; padding: 20px; border-radius: 8px; margin: 30px 0; text-align: center; }
        .footer { background-color: #f7fafc; padding: 30px; text-align: center; color: #718096; font-size: 14px; }
        @media (max-width: 600px) { .container { margin: 0 10px; } .header, .content, .footer { padding: 20px; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">📧 Postra</div>
            <div class="header-text">You've Been Invited!</div>
        </div>
        <div class="content">
            <h1 class="title">Join Postra Today!</h1>
            <div class="inviter">
                <p style="margin: 0; color: #2d3748;"><strong>${inviterName}</strong> has invited you to join Postra</p>
            </div>
            <p class="text">Postra is an AI-powered content creation platform. Join thousands of creators using AI to boost their content strategy.</p>
            <div style="text-align: center;"><a href="${inviteUrl}" class="button">Accept Invitation</a></div>
            <p class="text" style="font-size: 14px;">This invitation expires in 7 days. If you're not interested, you can safely ignore this email.</p>
        </div>
        <div class="footer">
            <p>© 2026 Postra. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;
}
