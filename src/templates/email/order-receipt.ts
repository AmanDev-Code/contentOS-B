/**
 * Order Receipt template - sent after successful payment
 */
import { wrapEmail } from './_base';

export function getOrderReceiptTemplate(orderDetails: {
  orderId: string;
  planName: string;
  amount: number;
  credits: number;
  date: string;
}): string {
  const content = `
    <h1 class="title">Thank you for your purchase</h1>
    <p class="text">Your payment has been processed successfully. Your credits have been added to your account and are ready to use.</p>
    <div style="background-color: #f4f4f5; border-radius: 6px; padding: 24px; margin: 28px 0; border: 1px solid #e4e4e7;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #71717a; font-size: 14px;">Order ID</td><td style="padding: 8px 0; text-align: right; font-weight: 500;">${orderDetails.orderId}</td></tr>
        <tr><td style="padding: 8px 0; color: #71717a; font-size: 14px;">Plan</td><td style="padding: 8px 0; text-align: right; font-weight: 500;">${orderDetails.planName}</td></tr>
        <tr><td style="padding: 8px 0; color: #71717a; font-size: 14px;">Credits</td><td style="padding: 8px 0; text-align: right; font-weight: 500;">${orderDetails.credits.toLocaleString()}</td></tr>
        <tr><td style="padding: 8px 0; color: #71717a; font-size: 14px;">Date</td><td style="padding: 8px 0; text-align: right; font-weight: 500;">${orderDetails.date}</td></tr>
        <tr><td style="padding: 12px 0 0; color: #18181b; font-weight: 600;">Total</td><td style="padding: 12px 0 0; text-align: right; font-weight: 600;">$${orderDetails.amount.toFixed(2)}</td></tr>
      </table>
    </div>
    <p class="text" style="font-size: 14px; color: #71717a;">Start creating content with AI right away from your dashboard.</p>
  `;
  return wrapEmail(content, 'Order Receipt - Trndinn');
}
