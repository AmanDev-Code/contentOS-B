import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { PaddleService } from '../services/paddle.service';

@Controller('paddle')
export class PaddleController {
  constructor(private readonly paddleService: PaddleService) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async webhook(
    @Req() req: any,
    @Headers('paddle-signature') paddleSignature: string,
    @Body() body: any,
  ) {
    const rawBodyBuffer: Buffer | undefined = req.rawBody;
    const rawBody = rawBodyBuffer
      ? rawBodyBuffer.toString('utf8')
      : JSON.stringify(body || {});

    const valid = this.paddleService.verifyWebhookSignature(
      rawBody,
      paddleSignature,
    );
    if (!valid) {
      return { success: false, message: 'Invalid Paddle signature' };
    }

    await this.paddleService.handleWebhook(body);
    return { success: true };
  }
}

