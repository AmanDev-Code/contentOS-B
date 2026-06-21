import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Request,
  Query,
  UseGuards,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { UserRateLimitGuard } from '../guards/user-rate-limit.guard';
import {
  OutboundWebhookService,
  type CreateWebhookDto,
  type UpdateWebhookDto,
} from '../services/outbound-webhook.service';
import { WebhookDeliveryService } from '../services/webhook-delivery.service';

@ApiTags('outbound-webhooks')
@Controller('webhooks')
@UseGuards(AuthGuard, UserRateLimitGuard, PaywallGuard)
export class OutboundWebhooksController {
  private readonly logger = new Logger(OutboundWebhooksController.name);

  constructor(
    private readonly webhookService: OutboundWebhookService,
    private readonly deliveryService: WebhookDeliveryService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create an outbound webhook' })
  async create(
    @Request() req: { user?: { id: string } },
    @Body() body: CreateWebhookDto,
  ) {
    const userId = req.user?.id;
    if (!userId) throw new BadRequestException('User ID not found');
    if (!body.url) throw new BadRequestException('url is required');

    try {
      const webhook = await this.webhookService.create(userId, body);
      return { webhook };
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Failed to create webhook',
      );
    }
  }

  @Get()
  @ApiOperation({ summary: 'List outbound webhooks' })
  async list(@Request() req: { user?: { id: string } }) {
    const userId = req.user?.id;
    if (!userId) throw new BadRequestException('User ID not found');
    const webhooks = await this.webhookService.list(userId);
    return { webhooks };
  }

  @Get('supported-events')
  @ApiOperation({ summary: 'List supported webhook event types' })
  getSupportedEvents() {
    return { events: OutboundWebhookService.getSupportedEvents() };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a webhook by ID' })
  async getById(
    @Request() req: { user?: { id: string } },
    @Param('id') id: string,
  ) {
    const userId = req.user?.id;
    if (!userId) throw new BadRequestException('User ID not found');
    const webhook = await this.webhookService.getById(userId, id);
    if (!webhook) throw new NotFoundException('Webhook not found');
    return { webhook };
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a webhook' })
  async update(
    @Request() req: { user?: { id: string } },
    @Param('id') id: string,
    @Body() body: UpdateWebhookDto,
  ) {
    const userId = req.user?.id;
    if (!userId) throw new BadRequestException('User ID not found');

    try {
      const webhook = await this.webhookService.update(userId, id, body);
      return { webhook };
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Failed to update webhook',
      );
    }
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a webhook' })
  async remove(
    @Request() req: { user?: { id: string } },
    @Param('id') id: string,
  ) {
    const userId = req.user?.id;
    if (!userId) throw new BadRequestException('User ID not found');
    await this.webhookService.delete(userId, id);
    return { success: true };
  }

  @Get(':id/deliveries')
  @ApiOperation({ summary: 'List delivery history for a webhook' })
  async listDeliveries(
    @Request() req: { user?: { id: string } },
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    const userId = req.user?.id;
    if (!userId) throw new BadRequestException('User ID not found');
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    const deliveries = await this.webhookService.listDeliveries(
      userId,
      id,
      parsedLimit,
    );
    return { deliveries };
  }

  @Post(':id/test')
  @ApiOperation({ summary: 'Send a test webhook delivery' })
  async testFire(
    @Request() req: { user?: { id: string } },
    @Param('id') id: string,
  ) {
    const userId = req.user?.id;
    if (!userId) throw new BadRequestException('User ID not found');

    try {
      const result = await this.deliveryService.testFire(userId, id);
      return {
        success:
          result.status !== null && result.status >= 200 && result.status < 300,
        status: result.status,
        body: result.body,
      };
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Test delivery failed',
      );
    }
  }
}
