import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { MaintenanceService } from '../services/maintenance.service';

interface AuthenticatedRequest extends Request {
  user: { id: string; email?: string };
}

@ValidatorConstraint({ name: 'isAfterScheduledStart', async: false })
class IsAfterScheduledStartConstraint implements ValidatorConstraintInterface {
  validate(
    scheduledEnd: string | undefined,
    args: ValidationArguments,
  ): boolean {
    const obj = args.object as SetMaintenanceDto;
    const scheduledStart = obj.scheduledStart;
    if (!scheduledStart || !scheduledEnd) return true;
    return (
      new Date(scheduledEnd).getTime() > new Date(scheduledStart).getTime()
    );
  }

  defaultMessage(): string {
    return 'scheduledEnd must be after scheduledStart';
  }
}

class SetMaintenanceDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ValidateIf(
    (o: SetMaintenanceDto) =>
      o.scheduledStart !== undefined || o.scheduledEnd !== undefined,
  )
  @IsISO8601()
  scheduledStart?: string;

  @ValidateIf(
    (o: SetMaintenanceDto) =>
      o.scheduledStart !== undefined || o.scheduledEnd !== undefined,
  )
  @IsISO8601()
  @Validate(IsAfterScheduledStartConstraint)
  scheduledEnd?: string;

  @IsOptional()
  @IsString()
  message?: string;
}

// ── Public endpoint ───────────────────────────────────────────────────────────

@ApiTags('maintenance')
@Controller('maintenance')
export class MaintenanceController {
  constructor(private readonly maintenanceService: MaintenanceService) {}

  @Get('status')
  @ApiOperation({ summary: 'Public: check whether maintenance mode is active' })
  getStatus() {
    return this.maintenanceService.getStatus();
  }
}

// ── Admin endpoints ───────────────────────────────────────────────────────────

@ApiTags('admin')
@Controller('admin/maintenance')
@UseGuards(AuthGuard, PaywallGuard, AdminGuard)
@ApiBearerAuth()
export class AdminMaintenanceController {
  constructor(private readonly maintenanceService: MaintenanceService) {}

  @Get()
  @ApiOperation({ summary: 'Get current maintenance config' })
  async getConfig() {
    const config = await this.maintenanceService.getConfig();
    return config ?? { enabled: false, updatedAt: null, updatedBy: null };
  }

  @Post()
  @ApiOperation({ summary: 'Update maintenance config' })
  setConfig(
    @Body() body: SetMaintenanceDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.maintenanceService.setConfig(body, req.user.id);
  }

  @Delete('schedule')
  @ApiOperation({ summary: 'Clear scheduled maintenance window' })
  clearSchedule(@Request() req: AuthenticatedRequest) {
    return this.maintenanceService.clearSchedule(req.user.id);
  }
}
