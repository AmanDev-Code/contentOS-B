import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  validateEvent,
  WebhookVerificationError,
} from '@polar-sh/sdk/webhooks';
import { PolarService } from '../services/polar.service';

@Controller('api/polar')
export class PolarController {
  constructor(
    private readonly polarService: PolarService,
    private readonly configService: ConfigService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async webhookHandler(
    @Req() req: { rawBody?: Buffer },
    @Headers('webhook-id') webhookId: string,
    @Headers('webhook-timestamp') webhookTimestamp: string,
    @Headers('webhook-signature') webhookSignature: string,
    @Body() body: Record<string, unknown>,
  ) {
    const webhookSecret =
      this.configService.get<string>('polar.webhookSecret') || '';

    const rawBodyBuffer: Buffer | undefined = req.rawBody;
    const rawBodyString = rawBodyBuffer
      ? rawBodyBuffer.toString('utf8')
      : JSON.stringify(body ?? {});

    const payloadForVerify =
      rawBodyBuffer ?? Buffer.from(rawBodyString, 'utf8');

    const headers: Record<string, string> = {
      'webhook-id': webhookId || '',
      'webhook-timestamp': webhookTimestamp || '',
      'webhook-signature': webhookSignature || '',
    };

    if (!webhookSecret) {
      this.polarService['logger'].warn(
        'POLAR_WEBHOOK_SECRET is not configured; skipping signature verification',
      );
      await this.polarService.handleWebhook(
        body as { type: string; data: Record<string, unknown> },
      );
      return { success: true };
    }

    try {
      const event = validateEvent(payloadForVerify, headers, webhookSecret) as {
        type: string;
        data: Record<string, unknown>;
      };

      await this.polarService.handleWebhook(event);
      return { success: true };
    } catch (error: unknown) {
      if (error instanceof WebhookVerificationError) {
        throw new ForbiddenException('Invalid webhook signature');
      }
      throw error;
    }
  }
}
