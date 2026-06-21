import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from './supabase.service';
import { EmailService } from './email.service';

export interface ContactSubmissionInput {
  name?: string;
  email: string;
  company?: string;
  message: string;
  source?: string;
  meta?: Record<string, unknown>;
}

const MAX_NAME = 200;
const MAX_COMPANY = 200;
const MAX_EMAIL = 320;
const MAX_MESSAGE = 5000;
const MIN_MESSAGE = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clamp(value: string | undefined, max: number): string {
  return (value ?? '').toString().trim().slice(0, max);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Handles public contact-form submissions: validates, persists a durable record
 * in `contact_messages` (service role), and fires a notification email to the
 * support inbox plus an acknowledgement to the sender via the existing SMTP2GO
 * EmailService. Designed to degrade gracefully: a stored row is the source of
 * truth even if email delivery is unavailable.
 */
@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);
  private readonly inbox: string;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {
    this.inbox =
      this.config.get<string>('CONTACT_INBOX_EMAIL') ||
      this.config.get<string>('SUPPORT_EMAIL') ||
      this.config.get<string>('SMTP2GO_FROM_EMAIL') ||
      'hello@trndinn.com';
  }

  async submit(
    input: ContactSubmissionInput,
  ): Promise<{ ok: true; id: string }> {
    const name = clamp(input.name, MAX_NAME);
    const email = clamp(input.email, MAX_EMAIL).toLowerCase();
    const company = clamp(input.company, MAX_COMPANY);
    const message = clamp(input.message, MAX_MESSAGE);
    const source = clamp(input.source, 64) || 'contact_page';

    if (!email || !EMAIL_RE.test(email)) {
      throw new BadRequestException('A valid email is required.');
    }
    if (message.length < MIN_MESSAGE) {
      throw new BadRequestException(
        'Please include a message of at least 10 characters.',
      );
    }

    // Persist first: the stored row is the durable source of truth.
    const { data, error } = await this.supabase
      .getServiceClient()
      .from('contact_messages')
      .insert({
        name: name || null,
        email,
        company: company || null,
        message,
        source,
        meta: input.meta ?? {},
      })
      .select('id')
      .single();

    if (error || !data) {
      this.logger.error(`Failed to store contact message: ${error?.message}`);
      throw new BadRequestException(
        'Could not submit your message. Please try again.',
      );
    }

    const id = data.id as string;

    // Fire-and-forget notifications. Never fail the request on email problems.
    void this.sendNotifications({
      id,
      name,
      email,
      company,
      message,
      source,
    }).catch((e) =>
      this.logger.error(
        `Contact email dispatch failed for ${id}: ${(e as Error).message}`,
      ),
    );

    return { ok: true, id };
  }

  private async sendNotifications(args: {
    id: string;
    name: string;
    email: string;
    company: string;
    message: string;
    source: string;
  }): Promise<void> {
    const { id, name, email, company, message, source } = args;
    const safeName = escapeHtml(name || 'Not provided');
    const safeCompany = escapeHtml(company || 'Not provided');
    const safeEmail = escapeHtml(email);
    const safeMessage = escapeHtml(message).replace(/\n/g, '<br />');

    // 1) Internal notification to the support inbox.
    await this.email.sendEmail({
      to: this.inbox,
      subject: `New contact message from ${name || email}`,
      html_body: `
        <div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#0b1120;">
          <h2 style="margin:0 0 12px;">New contact form submission</h2>
          <p style="margin:0 0 4px;"><strong>Name:</strong> ${safeName}</p>
          <p style="margin:0 0 4px;"><strong>Email:</strong> ${safeEmail}</p>
          <p style="margin:0 0 4px;"><strong>Company:</strong> ${safeCompany}</p>
          <p style="margin:0 0 4px;"><strong>Source:</strong> ${escapeHtml(source)}</p>
          <p style="margin:12px 0 4px;"><strong>Message:</strong></p>
          <div style="padding:12px 16px;background:#f4f5f7;border-radius:8px;">${safeMessage}</div>
          <p style="margin:16px 0 0;color:#64748b;font-size:12px;">Reference: ${id}</p>
        </div>
      `,
      text_body: `New contact form submission\n\nName: ${name || 'Not provided'}\nEmail: ${email}\nCompany: ${company || 'Not provided'}\nSource: ${source}\n\nMessage:\n${message}\n\nReference: ${id}`,
      template_id: 'contact-notification',
      custom_headers: [{ header: 'Reply-To', value: email }],
    });

    // 2) Acknowledgement to the sender.
    await this.email.sendEmail({
      to: email,
      subject: 'We received your message at Trndinn',
      html_body: `
        <div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#0b1120;">
          <h2 style="margin:0 0 12px;">Thanks for reaching out${name ? `, ${escapeHtml(name)}` : ''}</h2>
          <p style="margin:0 0 12px;">We have received your message and a member of the Trndinn team will get back to you soon.</p>
          <p style="margin:0 0 4px;color:#64748b;font-size:13px;">For your records, here is a copy of what you sent:</p>
          <div style="padding:12px 16px;background:#f4f5f7;border-radius:8px;">${safeMessage}</div>
          <p style="margin:16px 0 0;">Talk soon,<br />The Trndinn Team</p>
        </div>
      `,
      text_body: `Thanks for reaching out${name ? `, ${name}` : ''}.\n\nWe have received your message and a member of the Trndinn team will get back to you soon.\n\nYour message:\n${message}\n\nTalk soon,\nThe Trndinn Team`,
      template_id: 'contact-acknowledgement',
    });
  }
}
