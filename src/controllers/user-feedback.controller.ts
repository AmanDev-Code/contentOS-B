import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthGuard } from '../guards/auth.guard';
import {
  UserFeedbackService,
  FeedbackType,
} from '../services/user-feedback.service';

interface AuthedRequest extends Request {
  user: { id: string; email: string };
}

@ApiTags('user-feedback')
@Controller('user-feedback')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class UserFeedbackController {
  constructor(private readonly userFeedbackService: UserFeedbackService) {}

  @Post('submit')
  @ApiOperation({
    summary: 'Submit general feedback (can submit multiple times)',
  })
  async submit(
    @Req() req: AuthedRequest,
    @Body()
    body: {
      type: FeedbackType;
      message: string;
      rating?: number;
    },
  ) {
    return this.userFeedbackService.submitFeedback(req.user.id, body);
  }

  @Get('history')
  @ApiOperation({ summary: 'Get user feedback submission history' })
  async history(
    @Req() req: AuthedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.userFeedbackService.getUserFeedbackHistory(req.user.id, {
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 10,
    });
  }
}
