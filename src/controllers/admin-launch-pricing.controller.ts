import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { AdminGuard } from '../guards/admin.guard';
import { LaunchPricingService } from '../services/launch-pricing.service';

/**
 * DTO for creating a launch pricing config
 */
export class CreateLaunchPricingDto {
  @IsString()
  label: string;

  @IsNumber()
  @Min(1)
  standardMonthlyInr: number;

  @IsNumber()
  @Min(1)
  proMonthlyInr: number;

  @IsNumber()
  @Min(1)
  ultimateMonthlyInr: number;

  @IsOptional()
  @IsNumber()
  @Min(0.0001)
  usdConversionRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  yearlyDiscountPercent?: number;
}

/**
 * DTO for updating a launch pricing config
 */
export class UpdateLaunchPricingDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  standardMonthlyInr?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  proMonthlyInr?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  ultimateMonthlyInr?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.0001)
  usdConversionRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  yearlyDiscountPercent?: number;
}

/**
 * DTO for toggle active status
 */
export class ToggleActiveDto {
  @IsBoolean()
  isActive: boolean;
}

@ApiTags('admin')
@Controller('admin/launch-pricing')
@UseGuards(AuthGuard, PaywallGuard, AdminGuard)
@ApiBearerAuth()
export class AdminLaunchPricingController {
  constructor(private readonly launchPricingService: LaunchPricingService) {}

  /**
   * List all launch pricing configs
   */
  @Get()
  @ApiOperation({ summary: 'List all launch pricing configs' })
  async list() {
    try {
      const configs = await this.launchPricingService.list();
      return { success: true, data: configs };
    } catch (error) {
      throw new HttpException(
        error instanceof Error ? error.message : 'Failed to fetch configs',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Create a new launch pricing config
   */
  @Post()
  @UsePipes(new ValidationPipe({ transform: true }))
  @ApiOperation({ summary: 'Create a new launch pricing config' })
  async create(
    @Body() dto: CreateLaunchPricingDto,
    @Req() req: { user?: { id?: string } },
  ) {
    try {
      const config = await this.launchPricingService.create(
        {
          label: dto.label,
          standardMonthlyInr: dto.standardMonthlyInr,
          proMonthlyInr: dto.proMonthlyInr,
          ultimateMonthlyInr: dto.ultimateMonthlyInr,
          usdConversionRate: dto.usdConversionRate,
          yearlyDiscountPercent: dto.yearlyDiscountPercent,
        },
        req.user?.id,
      );
      return { success: true, data: config };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        error instanceof Error ? error.message : 'Failed to create config',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Update a launch pricing config
   */
  @Put(':id')
  @UsePipes(new ValidationPipe({ transform: true }))
  @ApiOperation({ summary: 'Update a launch pricing config' })
  async update(@Param('id') id: string, @Body() dto: UpdateLaunchPricingDto) {
    try {
      const config = await this.launchPricingService.update(id, {
        label: dto.label,
        standardMonthlyInr: dto.standardMonthlyInr,
        proMonthlyInr: dto.proMonthlyInr,
        ultimateMonthlyInr: dto.ultimateMonthlyInr,
        usdConversionRate: dto.usdConversionRate,
        yearlyDiscountPercent: dto.yearlyDiscountPercent,
      });
      return { success: true, data: config };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        error instanceof Error ? error.message : 'Failed to update config',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Delete a launch pricing config
   */
  @Delete(':id')
  @ApiOperation({ summary: 'Delete a launch pricing config' })
  async delete(@Param('id') id: string) {
    try {
      await this.launchPricingService.delete(id);
      return { success: true };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        error instanceof Error ? error.message : 'Failed to delete config',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Push active launch USD prices to Polar products (manual retry).
   */
  @Post(':id/sync-polar')
  @ApiOperation({
    summary: 'Sync launch pricing amounts to Polar catalog products',
  })
  async syncPolar(@Param('id') id: string) {
    try {
      const config = await this.launchPricingService.getById(id);
      if (!config.is_active) {
        throw new HttpException(
          'Enable this config before syncing to Polar',
          HttpStatus.BAD_REQUEST,
        );
      }
      const result = await this.launchPricingService.syncPolarForConfig(config);
      if (!result.success) {
        return {
          success: false,
          data: result,
          message:
            result.error ||
            'Polar catalog sync did not update any products. Check POLAR_ACCESS_TOKEN and POLAR_PRODUCT_* env vars.',
        };
      }
      return {
        success: true,
        data: result,
        message: `Synced ${result.synced} Polar product price(s)`,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Polar sync failed',
      };
    }
  }

  /**
   * Toggle the active status of a config
   * Only one config can be active at a time
   */
  @Post(':id/toggle')
  @UsePipes(new ValidationPipe({ transform: true }))
  @ApiOperation({ summary: 'Toggle active status (enable/disable) a config' })
  async toggle(@Param('id') id: string, @Body() dto: ToggleActiveDto) {
    try {
      const config = await this.launchPricingService.toggleActive(
        id,
        dto.isActive,
      );
      return {
        success: true,
        data: config,
        message: dto.isActive ? 'Config enabled' : 'Config disabled',
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        error instanceof Error ? error.message : 'Failed to toggle config',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get the currently active config (for admin view)
   */
  @Get('active')
  @ApiOperation({ summary: 'Get the currently active launch pricing config' })
  async getActive() {
    try {
      const config = await this.launchPricingService.getActive();
      if (!config) {
        return {
          success: true,
          data: null,
          message: 'No active launch pricing config',
        };
      }
      return { success: true, data: config };
    } catch (error) {
      throw new HttpException(
        error instanceof Error
          ? error.message
          : 'Failed to fetch active config',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get display-formatted data for the active config
   * This is what the frontend uses to show pricing
   */
  @Get('active/display')
  @ApiOperation({ summary: 'Get formatted display data for active config' })
  async getActiveDisplay() {
    try {
      const displayData = await this.launchPricingService.getDisplayData();
      if (!displayData) {
        return {
          success: true,
          data: null,
          message: 'No active launch pricing config',
        };
      }
      return { success: true, data: displayData };
    } catch (error) {
      throw new HttpException(
        error instanceof Error ? error.message : 'Failed to fetch display data',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
