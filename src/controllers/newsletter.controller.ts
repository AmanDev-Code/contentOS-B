import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { NewsletterService } from '../services/newsletter.service';

@ApiTags('newsletter')
@Controller('newsletter')
export class NewsletterController {
  private readonly logger = new Logger(NewsletterController.name);

  constructor(private readonly newsletter: NewsletterService) {}

  @Post('subscribe')
  @ApiOperation({ summary: 'Public newsletter subscription' })
  async subscribe(
    @Body() body: { email: string; name?: string; source?: string },
  ) {
    try {
      const subscriber = await this.newsletter.subscribe(
        body.email,
        body.name,
        body.source || 'website',
      );
      return {
        success: true,
        subscriber: { email: subscriber.email, name: subscriber.name },
      };
    } catch (e: any) {
      this.logger.error(`Subscribe error: ${e?.message}`);
      throw new HttpException(
        e.message || 'Subscription failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('unsubscribe/:token')
  @ApiOperation({ summary: 'Unsubscribe via token link' })
  async unsubscribeByToken(
    @Param('token') token: string,
    @Query('email') email: string,
  ) {
    try {
      await this.newsletter.unsubscribeByToken(token, email);
      return {
        success: true,
        message: 'You have been unsubscribed successfully.',
      };
    } catch (e: any) {
      this.logger.error(`Unsubscribe error: ${e?.message}`);
      throw new HttpException(
        e.message || 'Unsubscribe failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}

@ApiTags('newsletter-admin')
@Controller('admin/newsletter')
@ApiBearerAuth()
@UseGuards(AuthGuard, AdminGuard)
export class AdminNewsletterController {
  private readonly logger = new Logger(AdminNewsletterController.name);

  constructor(private readonly newsletter: NewsletterService) {}

  @Get('analytics')
  @ApiOperation({ summary: 'Get newsletter analytics dashboard' })
  async getAnalytics() {
    try {
      return await this.newsletter.getAnalytics();
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('config')
  @ApiOperation({ summary: 'Get Listmonk configuration status' })
  async getConfig() {
    try {
      return await this.newsletter.getListmonkConfig();
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('subscribers')
  @ApiOperation({ summary: 'List newsletter subscribers' })
  async listSubscribers(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    try {
      return await this.newsletter.getSubscribers(
        parseInt(page || '1', 10),
        parseInt(limit || '50', 10),
        status,
        search,
      );
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('subscribers/import')
  @ApiOperation({ summary: 'Import subscribers from CSV data' })
  async importSubscribers(
    @Body()
    body: {
      data: Array<{ email: string; name?: string; tags?: string[] }>;
      filename: string;
      source?: string;
    },
  ) {
    try {
      return await this.newsletter.importSubscribers(
        body.data,
        body.filename,
        body.source || 'import',
      );
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('subscribers/:email/unsubscribe')
  @ApiOperation({ summary: 'Manually unsubscribe a subscriber' })
  async unsubscribeManual(@Param('email') email: string) {
    try {
      return await this.newsletter.unsubscribe(email);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('campaigns')
  @ApiOperation({ summary: 'List newsletter campaigns' })
  async listCampaigns(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    try {
      return await this.newsletter.getCampaigns(
        parseInt(page || '1', 10),
        parseInt(limit || '50', 10),
        status,
      );
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('campaigns')
  @ApiOperation({ summary: 'Create a new campaign' })
  async createCampaign(
    @Body()
    body: {
      title: string;
      subject: string;
      preview_text?: string;
      body_html?: string;
      body_text?: string;
      template_id?: string;
      blog_post_id?: string;
    },
  ) {
    try {
      return await this.newsletter.createCampaign(body);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('campaigns/from-post/:postId')
  @ApiOperation({ summary: 'Create campaign from blog post' })
  async createCampaignFromPost(@Param('postId') postId: string) {
    try {
      return await this.newsletter.createCampaignFromPost(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('campaigns/:id')
  @ApiOperation({ summary: 'Get campaign details' })
  async getCampaign(@Param('id') id: string) {
    try {
      return await this.newsletter.getCampaign(id);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Patch('campaigns/:id')
  @ApiOperation({ summary: 'Update campaign' })
  async updateCampaign(
    @Param('id') id: string,
    @Body()
    body: {
      title?: string;
      subject?: string;
      preview_text?: string;
      body_html?: string;
      body_text?: string;
      template_id?: string;
    },
  ) {
    try {
      return await this.newsletter.updateCampaign(id, body);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('campaigns/:id/send')
  @ApiOperation({ summary: 'Send campaign immediately' })
  async sendCampaign(@Param('id') id: string) {
    try {
      return await this.newsletter.sendCampaign(id);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('campaigns/:id/schedule')
  @ApiOperation({ summary: 'Schedule campaign for later' })
  async scheduleCampaign(
    @Param('id') id: string,
    @Body() body: { scheduled_at: string },
  ) {
    try {
      return await this.newsletter.scheduleCampaign(
        id,
        new Date(body.scheduled_at),
      );
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('campaigns/:id/cancel')
  @ApiOperation({ summary: 'Cancel campaign' })
  async cancelCampaign(@Param('id') id: string) {
    try {
      return await this.newsletter.cancelCampaign(id);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('campaigns/:id/stats')
  @ApiOperation({ summary: 'Get campaign stats (syncs from Listmonk)' })
  async getCampaignStats(@Param('id') id: string) {
    try {
      return await this.newsletter.syncCampaignStats(id);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('templates')
  @ApiOperation({ summary: 'List email templates' })
  async listTemplates() {
    try {
      return await this.newsletter.getTemplates();
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('templates')
  @ApiOperation({ summary: 'Create email template' })
  async createTemplate(
    @Body() body: { name: string; html_template: string; is_default?: boolean },
  ) {
    try {
      return await this.newsletter.createTemplate(
        body.name,
        body.html_template,
        body.is_default,
      );
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Patch('templates/:id')
  @ApiOperation({ summary: 'Update email template' })
  async updateTemplate(
    @Param('id') id: string,
    @Body()
    body: { name?: string; html_template?: string; is_default?: boolean },
  ) {
    try {
      return await this.newsletter.updateTemplate(id, body);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
