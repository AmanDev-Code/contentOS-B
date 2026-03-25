import {
  Controller,
  Put,
  Body,
  Param,
  UseGuards,
  Request,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { SupabaseService } from '../services/supabase.service';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
  };
}

@Controller('content')
@UseGuards(AuthGuard, PaywallGuard)
export class ContentController {
  private readonly logger = new Logger(ContentController.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  @Put(':id')
  async updateContent(
    @Request() req: AuthenticatedRequest,
    @Param('id') contentId: string,
    @Body() body: { content?: string; hashtags?: string[] },
  ) {
    try {
      const userId = req.user.id;

      // Verify ownership
      const { data: existingContent, error: fetchError } =
        await this.supabaseService
          .getServiceClient()
          .from('generated_content')
          .select('user_id')
          .eq('id', contentId)
          .single();

      if (fetchError || !existingContent) {
        throw new HttpException('Content not found', HttpStatus.NOT_FOUND);
      }

      if (existingContent.user_id !== userId) {
        throw new HttpException('Unauthorized', HttpStatus.FORBIDDEN);
      }

      // Update content
      const updateData: any = {};
      if (body.content !== undefined) {
        updateData.content = body.content;
      }
      if (body.hashtags !== undefined) {
        updateData.hashtags = body.hashtags;
      }

      const { data, error } = await this.supabaseService
        .getServiceClient()
        .from('generated_content')
        .update(updateData)
        .eq('id', contentId)
        .select()
        .single();

      if (error) {
        throw new HttpException(
          'Failed to update content',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return {
        success: true,
        data,
      };
    } catch (error) {
      this.logger.error('Failed to update content:', error.message);
      throw new HttpException(
        error.message || 'Failed to update content',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
