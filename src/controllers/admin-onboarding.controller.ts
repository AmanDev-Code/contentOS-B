import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { AdminGuard } from '../guards/admin.guard';
import {
  OnboardingService,
  CreateQuestionDto,
  UpdateQuestionDto,
} from '../services/onboarding.service';

@ApiTags('admin-onboarding')
@Controller('admin/onboarding')
@UseGuards(AuthGuard, PaywallGuard, AdminGuard)
@ApiBearerAuth()
export class AdminOnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // QUESTIONS CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('questions')
  @ApiOperation({
    summary: 'List all onboarding questions (including inactive)',
  })
  async listQuestions() {
    try {
      const questions = await this.onboardingService.listAllQuestions();
      return { success: true, data: questions };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to fetch questions',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('questions/:id')
  @ApiOperation({ summary: 'Get a single question by ID' })
  async getQuestion(@Param('id') id: string) {
    try {
      const question = await this.onboardingService.getQuestionById(id);
      return { success: true, data: question };
    } catch (error) {
      if (error.status === 404) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(
        error.message || 'Failed to fetch question',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('questions')
  @ApiOperation({ summary: 'Create a new onboarding question' })
  async createQuestion(@Body() body: CreateQuestionDto) {
    if (!body.question_text?.trim()) {
      throw new HttpException(
        'question_text is required',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!body.question_key?.trim()) {
      throw new HttpException(
        'question_key is required',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (body.step_number === undefined || body.step_number < 1) {
      throw new HttpException(
        'step_number must be a positive integer',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!Array.isArray(body.options) || body.options.length === 0) {
      throw new HttpException(
        'options must be a non-empty array',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const question = await this.onboardingService.createQuestion(body);
      return { success: true, data: question };
    } catch (error) {
      if (error.message?.includes('duplicate key')) {
        throw new HttpException(
          `Question with key "${body.question_key}" already exists`,
          HttpStatus.CONFLICT,
        );
      }
      throw new HttpException(
        error.message || 'Failed to create question',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Put('questions/:id')
  @ApiOperation({ summary: 'Update an onboarding question' })
  async updateQuestion(
    @Param('id') id: string,
    @Body() body: UpdateQuestionDto,
  ) {
    if (body.step_number !== undefined && body.step_number < 1) {
      throw new HttpException(
        'step_number must be a positive integer',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (body.options !== undefined && !Array.isArray(body.options)) {
      throw new HttpException(
        'options must be an array',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const question = await this.onboardingService.updateQuestion(id, body);
      return { success: true, data: question };
    } catch (error) {
      if (error.status === 404) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      if (error.message?.includes('duplicate key')) {
        throw new HttpException(
          `Question with key "${body.question_key}" already exists`,
          HttpStatus.CONFLICT,
        );
      }
      throw new HttpException(
        error.message || 'Failed to update question',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Patch('questions/:id')
  @ApiOperation({ summary: 'Partially update an onboarding question' })
  async patchQuestion(
    @Param('id') id: string,
    @Body() body: UpdateQuestionDto,
  ) {
    return this.updateQuestion(id, body);
  }

  @Delete('questions/:id')
  @ApiOperation({ summary: 'Delete an onboarding question' })
  async deleteQuestion(@Param('id') id: string) {
    try {
      await this.onboardingService.deleteQuestion(id);
      return { success: true };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to delete question',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('questions/reorder')
  @ApiOperation({ summary: 'Reorder questions by updating step numbers' })
  async reorderQuestions(
    @Body() body: { orders: { id: string; step_number: number }[] },
  ) {
    if (!Array.isArray(body.orders) || body.orders.length === 0) {
      throw new HttpException(
        'orders must be a non-empty array',
        HttpStatus.BAD_REQUEST,
      );
    }

    for (const item of body.orders) {
      if (!item.id || item.step_number === undefined || item.step_number < 1) {
        throw new HttpException(
          'Each order item must have id and positive step_number',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    try {
      const questions = await this.onboardingService.reorderQuestions(
        body.orders,
      );
      return { success: true, data: questions };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to reorder questions',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESPONSE ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('responses/stats')
  @ApiOperation({ summary: 'Get aggregate stats on onboarding responses' })
  async getResponseStats() {
    try {
      const questions = await this.onboardingService.listAllQuestions();

      // For each question, we could compute response distribution
      // This is a placeholder - in production you'd want a proper aggregation query
      return {
        success: true,
        data: {
          totalQuestions: questions.length,
          activeQuestions: questions.filter((q) => q.is_active).length,
          requiredQuestions: questions.filter((q) => q.is_required).length,
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to fetch response stats',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
