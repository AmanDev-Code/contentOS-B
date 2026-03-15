/**
 * Email Verification template - sent to new users to verify their email
 */
export function getVerificationTemplate(verificationUrl: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verify Your Email - Postra</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc; }
        .container { max-width: 600px; margin: 0 auto; background-color: white; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center; }
        .logo { color: white; font-size: 28px; font-weight: bold; margin-bottom: 10px; }
        .header-text { color: rgba(255,255,255,0.9); font-size: 16px; }
        .content { padding: 40px 30px; }
        .title { font-size: 24px; font-weight: 600; color: #1a202c; margin-bottom: 20px; }
        .text { color: #4a5568; line-height: 1.6; margin-bottom: 30px; }
        .button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-weight: 600; margin: 20px 0; }
        .footer { background-color: #f7fafc; padding: 30px; text-align: center; color: #718096; font-size: 14px; }
        .divider { height: 1px; background-color: #e2e8f0; margin: 30px 0; }
        @media (max-width: 600px) { .container { margin: 0 10px; } .header, .content, .footer { padding: 20px; } .title { font-size: 20px; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🚀 Postra</div>
            <div class="header-text">AI-Powered Content Creation Platform</div>
        </div>
        <div class="content">
            <h1 class="title">Welcome to Postra!</h1>
            <p class="text">Thank you for joining Postra. To get started, please verify your email address.</p>
            <div style="text-align: center;"><a href="${verificationUrl}" class="button">Verify Email Address</a></div>
            <div class="divider"></div>
            <p class="text" style="font-size: 14px;">If the button doesn't work, copy this link: <a href="${verificationUrl}" style="color: #667eea; word-break: break-all;">${verificationUrl}</a></p>
            <p class="text" style="font-size: 14px; color: #718096;">This link expires in 24 hours. If you didn't create an account, ignore this email.</p>
        </div>
        <div class="footer">
            <p>© 2026 Postra. All rights reserved.</p>
            <p>Need help? <a href="mailto:support@postra.katana-ai.com" style="color: #667eea;">support@postra.katana-ai.com</a></p>
        </div>
    </div>
</body>
</html>`;
}
