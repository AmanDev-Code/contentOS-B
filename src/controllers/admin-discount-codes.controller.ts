import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { AdminGuard } from '../guards/admin.guard';
import {
  DiscountCodesService,
  type BillingCycle,
  type DiscountDuration,
  type DiscountType,
  type PlanType,
} from '../services/discount-codes.service';

class CreateDiscountCodeDto {
  @IsString()
  code: string;

  @IsString()
  name: string;

  @IsIn(['percentage', 'fixed'])
  discountType: DiscountType;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(100)
  percentOff?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  amountOff?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsArray()
  @IsIn(['standard', 'pro', 'ultimate'], { each: true })
  planTypes?: PlanType[];

  @IsOptional()
  @IsArray()
  @IsIn(['monthly', 'yearly'], { each: true })
  billingCycles?: BillingCycle[];

  @IsOptional()
  @IsIn(['once', 'forever', 'repeating'])
  duration?: DiscountDuration;

  @IsOptional()
  @IsNumber()
  @Min(1)
  durationInMonths?: number;

  @IsOptional()
  @IsString()
  expiresAt?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxRedemptions?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

class UpdateDiscountCodeDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn(['percentage', 'fixed'])
  discountType?: DiscountType;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(100)
  percentOff?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  amountOff?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsArray()
  @IsIn(['standard', 'pro', 'ultimate'], { each: true })
  planTypes?: PlanType[];

  @IsOptional()
  @IsArray()
  @IsIn(['monthly', 'yearly'], { each: true })
  billingCycles?: BillingCycle[];

  @IsOptional()
  @IsIn(['once', 'forever', 'repeating'])
  duration?: DiscountDuration;

  @IsOptional()
  @IsNumber()
  @Min(1)
  durationInMonths?: number;

  @IsOptional()
  @IsString()
  expiresAt?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxRedemptions?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

@Controller('admin/discount-codes')
@UseGuards(AuthGuard, PaywallGuard, AdminGuard)
export class AdminDiscountCodesController {
  constructor(private readonly discountCodesService: DiscountCodesService) {}

  @Get()
  async list(@Query('includeInactive') includeInactive?: string) {
    const rows = await this.discountCodesService.list(
      includeInactive !== 'false',
    );
    return { ok: true, data: rows };
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    const row = await this.discountCodesService.getById(id);
    return { ok: true, data: row };
  }

  @Post()
  @UsePipes(new ValidationPipe({ transform: true }))
  async create(
    @Body() dto: CreateDiscountCodeDto,
    @Req() req: { user?: { id?: string } },
  ) {
    const row = await this.discountCodesService.create(
      {
        code: dto.code,
        name: dto.name,
        discountType: dto.discountType,
        percentOff: dto.percentOff,
        amountOff: dto.amountOff,
        currency: dto.currency,
        planTypes: dto.planTypes,
        billingCycles: dto.billingCycles,
        duration: dto.duration,
        durationInMonths: dto.durationInMonths,
        expiresAt: dto.expiresAt,
        maxRedemptions: dto.maxRedemptions,
        metadata: dto.metadata,
      },
      req.user?.id,
    );
    return { ok: true, data: row };
  }

  @Put(':id')
  @UsePipes(new ValidationPipe({ transform: true }))
  async update(@Param('id') id: string, @Body() dto: UpdateDiscountCodeDto) {
    const row = await this.discountCodesService.update(id, dto);
    return { ok: true, data: row };
  }

  @Post(':id/deactivate')
  async deactivate(@Param('id') id: string) {
    const row = await this.discountCodesService.deactivate(id);
    return { ok: true, data: row };
  }

  @Post(':id/sync')
  async sync(@Param('id') id: string) {
    const row = await this.discountCodesService.retrySync(id);
    return { ok: true, data: row };
  }
}
