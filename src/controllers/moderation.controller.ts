import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../guards/auth.guard';
import { PlatformStaffGuard } from '../guards/platform-staff.guard';
import { ModerationService } from '../modules/moderation/moderation.service';
import { containsCussWord } from '../modules/moderation/cuss-words';

@ApiTags('moderation')
@Controller('moderation')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class ModerationController {
  constructor(private readonly moderationService: ModerationService) {}

  @Get('word-list')
  @UseGuards(PlatformStaffGuard)
  @ApiOperation({
    summary: 'Get the profanity word list (platform staff only)',
  })
  getWordList() {
    return { words: this.moderationService.getWordList() };
  }

  @Post('check')
  @ApiOperation({ summary: 'Check text for profanity' })
  async checkText(
    @Request() req: AuthenticatedRequest,
    @Body() body: { text: string },
  ) {
    const text = body?.text;
    if (!text || typeof text !== 'string') {
      return { blocked: false };
    }

    const result = containsCussWord(text);

    if (result.hit && req.user?.id) {
      this.moderationService
        .recordStrike(req.user.id, text, result.matches, 'ui')
        .catch(() => {});
    }

    return { blocked: result.hit };
  }
}
