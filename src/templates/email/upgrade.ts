/**
 * Account Upgrade template - sent when users upgrade their subscription
 */
export function getUpgradeTemplate(planName: string, amount: number): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Account Upgraded - Postra</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc; }
        .container { max-width: 600px; margin: 0 auto; background-color: white; }
        .header { background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); padding: 40px 30px; text-align: center; }
        .logo { color: white; font-size: 28px; font-weight: bold; margin-bottom: 10px; }
        .content { padding: 40px 30px; }
        .title { font-size: 24px; font-weight: 600; color: #1a202c; margin-bottom: 20px; }
        .text { color: #4a5568; line-height: 1.6; margin-bottom: 30px; }
        .highlight { background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); color: white; padding: 20px; border-radius: 8px; text-align: center; margin: 30px 0; }
        .features { background-color: #f7fafc; padding: 20px; border-radius: 8px; margin: 30px 0; }
        .feature { display: flex; align-items: center; margin: 10px 0; }
        .footer { background-color: #f7fafc; padding: 30px; text-align: center; color: #718096; font-size: 14px; }
        @media (max-width: 600px) { .container { margin: 0 10px; } .header, .content, .footer { padding: 20px; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🎉 Postra</div>
            <div class="header-text">Account Successfully Upgraded</div>
        </div>
        <div class="content">
            <h1 class="title">Welcome to ${planName}!</h1>
            <p class="text">Congratulations! Your account has been upgraded to <strong>${planName}</strong>. You now have access to premium features.</p>
            <div class="highlight">
                <h3 style="margin: 0 0 10px 0; font-size: 18px;">Upgrade Summary</h3>
                <p style="margin: 0; font-size: 16px;"><strong>${planName}</strong> - $${amount}</p>
            </div>
            <div class="features">
                <h4 style="margin: 0 0 15px 0; color: #2d3748;">What's New:</h4>
                <div class="feature"><span style="color: #48bb78; margin-right: 10px;">✅</span>Increased AI credit limits</div>
                <div class="feature"><span style="color: #48bb78; margin-right: 10px;">✅</span>Priority content generation</div>
                <div class="feature"><span style="color: #48bb78; margin-right: 10px;">✅</span>Advanced scheduling features</div>
                <div class="feature"><span style="color: #48bb78; margin-right: 10px;">✅</span>Premium support</div>
            </div>
        </div>
        <div class="footer">
            <p>© 2026 Postra. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;
}
