import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ContactService } from '../services/contact.service';

/**
 * Public, unauthenticated contact-form endpoint for the marketing /contact page.
 * Persists the message and dispatches notification + acknowledgement emails.
 */
@ApiTags('public')
@Controller('public')
export class ContactController {
  private readonly logger = new Logger(ContactController.name);

  constructor(private readonly contactService: ContactService) {}

  @Post('contact')
  @ApiOperation({ summary: 'Submit a public contact-form message' })
  async submit(
    @Body()
    body: {
      name?: string;
      email?: string;
      company?: string;
      message?: string;
      // Honeypot: bots fill hidden fields. If present, silently accept and drop.
      website?: string;
    },
  ) {
    try {
      // Honeypot trap: pretend success without storing or emailing.
      if (body?.website && body.website.trim().length > 0) {
        return { ok: true };
      }

      if (!body?.email?.trim() || !body?.message?.trim()) {
        throw new HttpException(
          'email and message are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.contactService.submit({
        name: body.name,
        email: body.email,
        company: body.company,
        message: body.message,
        source: 'contact_page',
      });

      return { ok: true, id: result.id };
    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      this.logger.error(e?.message);
      throw new HttpException(
        e?.message || 'Failed to submit message',
        e?.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
