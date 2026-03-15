/**
 * Order Receipt template - sent after successful payment
 */
export function getOrderReceiptTemplate(orderDetails: {
  orderId: string;
  planName: string;
  amount: number;
  credits: number;
  date: string;
}): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Order Receipt - Postra</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc; }
        .container { max-width: 600px; margin: 0 auto; background-color: white; }
        .header { background-color: #2d3748; padding: 40px 30px; text-align: center; }
        .logo { color: white; font-size: 28px; font-weight: bold; margin-bottom: 10px; }
        .content { padding: 40px 30px; }
        .title { font-size: 24px; font-weight: 600; color: #1a202c; margin-bottom: 20px; }
        .receipt { background-color: #f7fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 25px; margin: 30px 0; }
        .receipt-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
        .receipt-row:last-child { border-bottom: none; font-weight: 600; }
        .receipt-label { color: #4a5568; }
        .receipt-value { color: #1a202c; font-weight: 500; }
        .footer { background-color: #f7fafc; padding: 30px; text-align: center; color: #718096; font-size: 14px; }
        @media (max-width: 600px) { .container { margin: 0 10px; } .header, .content, .footer { padding: 20px; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🧾 Postra</div>
            <div class="header-text">Order Receipt</div>
        </div>
        <div class="content">
            <h1 class="title">Thank You for Your Purchase!</h1>
            <p class="text">Your payment has been processed successfully. Here are the details of your order:</p>
            <div class="receipt">
                <div class="receipt-row"><span class="receipt-label">Order ID:</span><span class="receipt-value">${orderDetails.orderId}</span></div>
                <div class="receipt-row"><span class="receipt-label">Plan:</span><span class="receipt-value">${orderDetails.planName}</span></div>
                <div class="receipt-row"><span class="receipt-label">Credits:</span><span class="receipt-value">${orderDetails.credits.toLocaleString()}</span></div>
                <div class="receipt-row"><span class="receipt-label">Date:</span><span class="receipt-value">${orderDetails.date}</span></div>
                <div class="receipt-row"><span class="receipt-label">Total:</span><span class="receipt-value">$${orderDetails.amount}</span></div>
            </div>
            <p class="text">Your credits have been added to your account and are ready to use.</p>
        </div>
        <div class="footer">
            <p>© 2026 Postra. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;
}
