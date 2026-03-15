/**
 * Password Reset template - sent when users request a password reset
 */
export function getPasswordResetTemplate(resetUrl: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Reset Your Password - Postra</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc; }
        .container { max-width: 600px; margin: 0 auto; background-color: white; }
        .header { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 40px 30px; text-align: center; }
        .logo { color: white; font-size: 28px; font-weight: bold; margin-bottom: 10px; }
        .content { padding: 40px 30px; }
        .title { font-size: 24px; font-weight: 600; color: #1a202c; margin-bottom: 20px; }
        .text { color: #4a5568; line-height: 1.6; margin-bottom: 30px; }
        .button { display: inline-block; background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-weight: 600; margin: 20px 0; }
        .alert { background-color: #fed7d7; border: 1px solid #feb2b2; color: #c53030; padding: 15px; border-radius: 8px; margin: 20px 0; }
        .footer { background-color: #f7fafc; padding: 30px; text-align: center; color: #718096; font-size: 14px; }
        @media (max-width: 600px) { .container { margin: 0 10px; } .header, .content, .footer { padding: 20px; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🔐 Postra</div>
            <div class="header-text">Password Reset Request</div>
        </div>
        <div class="content">
            <h1 class="title">Reset Your Password</h1>
            <p class="text">We received a request to reset your password. Click the button below to create a new password.</p>
            <div style="text-align: center;"><a href="${resetUrl}" class="button">Reset Password</a></div>
            <div class="alert"><strong>⚠️ Security:</strong> This link expires in 1 hour. If you didn't request this, ignore this email.</div>
            <p class="text" style="font-size: 14px;">Or copy this link: <a href="${resetUrl}" style="color: #f5576c; word-break: break-all;">${resetUrl}</a></p>
        </div>
        <div class="footer">
            <p>© 2026 Postra. All rights reserved.</p>
            <p><a href="mailto:support@postra.katana-ai.com" style="color: #f5576c;">support@postra.katana-ai.com</a></p>
        </div>
    </div>
</body>
</html>`;
}
