/**
 * Welcome template - sent after email verification
 */
export function getWelcomeTemplate(userName: string, dashboardUrl: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome to Postra</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc; }
        .container { max-width: 600px; margin: 0 auto; background-color: white; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center; }
        .logo { color: white; font-size: 28px; font-weight: bold; margin-bottom: 10px; }
        .content { padding: 40px 30px; }
        .title { font-size: 24px; font-weight: 600; color: #1a202c; margin-bottom: 20px; }
        .text { color: #4a5568; line-height: 1.6; margin-bottom: 30px; }
        .button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-weight: 600; margin: 20px 0; }
        .steps { background-color: #f7fafc; padding: 25px; border-radius: 8px; margin: 30px 0; }
        .step { margin: 15px 0; padding-left: 30px; position: relative; }
        .step-number { position: absolute; left: 0; top: 0; background: #667eea; color: white; width: 20px; height: 20px; border-radius: 50%; text-align: center; font-size: 12px; line-height: 20px; font-weight: bold; }
        .footer { background-color: #f7fafc; padding: 30px; text-align: center; color: #718096; font-size: 14px; }
        @media (max-width: 600px) { .container { margin: 0 10px; } .header, .content, .footer { padding: 20px; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🎉 Postra</div>
            <div class="header-text">Welcome to AI-Powered Content Creation</div>
        </div>
        <div class="content">
            <h1 class="title">Welcome, ${userName}!</h1>
            <p class="text">Thank you for joining Postra! You're now part of a community revolutionizing content creation with AI.</p>
            <div class="steps">
                <h3 style="margin: 0 0 20px 0; color: #2d3748;">Getting Started:</h3>
                <div class="step"><div class="step-number">1</div><strong>Complete your profile</strong> - Add your LinkedIn account</div>
                <div class="step"><div class="step-number">2</div><strong>Generate your first post</strong> - Use "Find Viral Topic"</div>
                <div class="step"><div class="step-number">3</div><strong>Schedule or publish</strong> - Post immediately or schedule</div>
            </div>
            <div style="text-align: center;"><a href="${dashboardUrl}" class="button">Start Creating Content</a></div>
        </div>
        <div class="footer">
            <p>© 2026 Postra. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;
}
