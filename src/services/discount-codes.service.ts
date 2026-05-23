import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from './supabase.service';
import { PolarService } from './polar.service';

export type DiscountType = 'percentage' | 'fixed';
export type DiscountDuration = 'once' | 'forever' | 'repeating';
export type PlanType = 'standard' | 'pro' | 'ultimate';
export type BillingCycle = 'monthly' | 'yearly';

export type DiscountCodeRow = {
  id: string;
  code: string;
  name: string;
  discount_type: DiscountType;
  percent_off: number | null;
  amount_off: number | null;
  currency: string;
  plan_types: string[] | null;
  billing_cycles: string[] | null;
  duration: DiscountDuration;
  duration_in_months: number | null;
  polar_discount_id: string | null;
  active: boolean;
  expires_at: string | null;
  max_redemptions: number | null;
  redemption_count: number;
  polar_sync_status: string;
  polar_sync_error: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateDiscountCodeInput = {
  code: string;
  name: string;
  discountType: DiscountType;
  percentOff?: number;
  amountOff?: number;
  currency?: string;
  planTypes?: PlanType[] | null;
  billingCycles?: BillingCycle[] | null;
  duration?: DiscountDuration;
  durationInMonths?: number | null;
  expiresAt?: string | null;
  maxRedemptions?: number | null;
  metadata?: Record<string, unknown>;
};

export type UpdateDiscountCodeInput = Partial<
  Omit<CreateDiscountCodeInput, 'code'>
> & {
  code?: string;
  active?: boolean;
};

@Injectable()
export class DiscountCodesService {
  private readonly logger = new Logger(DiscountCodesService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly polarService: PolarService,
    private readonly configService: ConfigService,
  ) {}

  private db() {
    return this.supabaseService.getServiceClient();
  }

  normalizeCode(raw: string): string {
    const code = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 3 || code.length > 64) {
      throw new BadRequestException(
        'Code must be 3–64 alphanumeric characters after normalization',
      );
    }
    return code;
  }

  async list(includeInactive = true): Promise<DiscountCodeRow[]> {
    let q = this.db()
      .from('discount_codes')
      .select('*')
      .order('created_at', { ascending: false });
    if (!includeInactive) {
      q = q.eq('active', true);
    }
    const { data, error } = await q;
    if (error) throw new BadGatewayException(error.message);
    return (data || []) as DiscountCodeRow[];
  }

  /** Alias for list() - returns all discount codes including inactive */
  async listAll(): Promise<DiscountCodeRow[]> {
    return this.list(true);
  }

  async getById(id: string): Promise<DiscountCodeRow> {
    const { data, error } = await this.db()
      .from('discount_codes')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new BadGatewayException(error.message);
    if (!data) throw new NotFoundException('Discount code not found');
    return data as DiscountCodeRow;
  }

  async getByCode(code: string): Promise<DiscountCodeRow | null> {
    const normalized = this.normalizeCode(code);
    const { data, error } = await this.db()
      .from('discount_codes')
      .select('*')
      .ilike('code', normalized)
      .maybeSingle();
    if (error) throw new BadGatewayException(error.message);
    return (data as DiscountCodeRow) || null;
  }

  private validatePlanBilling(
    row: DiscountCodeRow,
    planType: PlanType,
    billingCycle: BillingCycle,
  ): void {
    if (row.plan_types?.length && !row.plan_types.includes(planType)) {
      throw new BadRequestException(
        `This code does not apply to the ${planType} plan`,
      );
    }
    if (row.billing_cycles?.length && !row.billing_cycles.includes(billingCycle)) {
      throw new BadRequestException(
        `This code does not apply to ${billingCycle} billing`,
      );
    }
  }

  private assertRedeemable(row: DiscountCodeRow): void {
    if (!row.active) {
      throw new BadRequestException('This discount code is no longer active');
    }
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      throw new BadRequestException('This discount code has expired');
    }
    if (
      row.max_redemptions != null &&
      row.redemption_count >= row.max_redemptions
    ) {
      throw new BadRequestException(
        'This discount code has reached its redemption limit',
      );
    }
    if (!row.polar_discount_id) {
      throw new BadRequestException(
        'This discount code is not available for checkout yet (Polar sync pending)',
      );
    }
  }

  /**
   * Validate a code for checkout; returns public-safe fields + polar_discount_id.
   */
  async validateForCheckout(
    code: string,
    planType: PlanType,
    billingCycle: BillingCycle,
  ): Promise<{
    code: string;
    name: string;
    discountType: DiscountType;
    percentOff: number | null;
    amountOff: number | null;
    currency: string;
    polarDiscountId: string;
  }> {
    const row = await this.getByCode(code);
    if (!row) {
      throw new BadRequestException('Invalid discount code');
    }
    this.assertRedeemable(row);
    this.validatePlanBilling(row, planType, billingCycle);
    return {
      code: row.code,
      name: row.name,
      discountType: row.discount_type,
      percentOff: row.percent_off,
      amountOff: row.amount_off,
      currency: row.currency,
      polarDiscountId: row.polar_discount_id!,
    };
  }

  async create(
    input: CreateDiscountCodeInput,
    createdBy?: string,
  ): Promise<DiscountCodeRow> {
    const code = this.normalizeCode(input.code);
    const currency = (input.currency || 'USD').toUpperCase();
    const duration = input.duration || 'once';

    if (input.discountType === 'percentage') {
      if (input.percentOff == null || input.percentOff <= 0 || input.percentOff > 100) {
        throw new BadRequestException('percentOff must be between 0 and 100');
      }
    } else if (input.amountOff == null || input.amountOff <= 0) {
      throw new BadRequestException('amountOff must be a positive number');
    }

    if (duration === 'repeating' && !input.durationInMonths) {
      throw new BadRequestException(
        'durationInMonths is required when duration is repeating',
      );
    }

    const payload = {
      code,
      name: input.name.trim(),
      discount_type: input.discountType,
      percent_off:
        input.discountType === 'percentage' ? input.percentOff : null,
      amount_off: input.discountType === 'fixed' ? input.amountOff : null,
      currency,
      plan_types: input.planTypes?.length ? input.planTypes : null,
      billing_cycles: input.billingCycles?.length ? input.billingCycles : null,
      duration,
      duration_in_months: input.durationInMonths ?? null,
      expires_at: input.expiresAt ?? null,
      max_redemptions: input.maxRedemptions ?? null,
      metadata: input.metadata ?? {},
      created_by: createdBy ?? null,
      polar_sync_status: 'pending',
      polar_sync_error: null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await this.db()
      .from('discount_codes')
      .insert(payload)
      .select('*')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new BadRequestException('A discount code with this value already exists');
      }
      throw new BadGatewayException(error.message);
    }

    return this.syncRowToPolar(data as DiscountCodeRow);
  }

  async update(
    id: string,
    input: UpdateDiscountCodeInput,
  ): Promise<DiscountCodeRow> {
    const existing = await this.getById(id);
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (input.code !== undefined) {
      patch.code = this.normalizeCode(input.code);
    }
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.discountType !== undefined) patch.discount_type = input.discountType;
    if (input.percentOff !== undefined) patch.percent_off = input.percentOff;
    if (input.amountOff !== undefined) patch.amount_off = input.amountOff;
    if (input.currency !== undefined) patch.currency = input.currency.toUpperCase();
    if (input.planTypes !== undefined) {
      patch.plan_types = input.planTypes?.length ? input.planTypes : null;
    }
    if (input.billingCycles !== undefined) {
      patch.billing_cycles = input.billingCycles?.length ? input.billingCycles : null;
    }
    if (input.duration !== undefined) patch.duration = input.duration;
    if (input.durationInMonths !== undefined) {
      patch.duration_in_months = input.durationInMonths;
    }
    if (input.expiresAt !== undefined) patch.expires_at = input.expiresAt;
    if (input.maxRedemptions !== undefined) {
      patch.max_redemptions = input.maxRedemptions;
    }
    if (input.metadata !== undefined) patch.metadata = input.metadata;
    if (input.active !== undefined) patch.active = input.active;

    const { data, error } = await this.db()
      .from('discount_codes')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new BadRequestException('A discount code with this value already exists');
      }
      throw new BadGatewayException(error.message);
    }

    const row = data as DiscountCodeRow;
    const valueChanged =
      input.code !== undefined ||
      input.discountType !== undefined ||
      input.percentOff !== undefined ||
      input.amountOff !== undefined ||
      input.currency !== undefined ||
      input.planTypes !== undefined ||
      input.billingCycles !== undefined ||
      input.duration !== undefined ||
      input.durationInMonths !== undefined ||
      input.expiresAt !== undefined ||
      input.maxRedemptions !== undefined;

    if (valueChanged || !existing.polar_discount_id) {
      return this.syncRowToPolar(row);
    }
    return row;
  }

  async deactivate(id: string): Promise<DiscountCodeRow> {
    const row = await this.getById(id);
    if (row.polar_discount_id) {
      try {
        await this.polarService.deletePolarDiscount(row.polar_discount_id);
      } catch (e) {
        this.logger.warn(
          `Polar discount delete failed for ${row.code}: ${e}`,
        );
      }
    }
    const { data, error } = await this.db()
      .from('discount_codes')
      .update({
        active: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new BadGatewayException(error.message);
    return data as DiscountCodeRow;
  }

  async retrySync(id: string): Promise<DiscountCodeRow> {
    const row = await this.getById(id);
    return this.syncRowToPolar(row);
  }

  async recordRedemption(polarDiscountId: string | null | undefined): Promise<void> {
    if (!polarDiscountId) return;
    const { data: row } = await this.db()
      .from('discount_codes')
      .select('id, redemption_count')
      .eq('polar_discount_id', polarDiscountId)
      .maybeSingle();
    if (!row) return;
    await this.db()
      .from('discount_codes')
      .update({
        redemption_count: (row.redemption_count || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id);
  }

  private async syncRowToPolar(row: DiscountCodeRow): Promise<DiscountCodeRow> {
    const accessToken =
      this.configService.get<string>('polar.accessToken') || '';
    if (!accessToken) {
      const { data } = await this.db()
        .from('discount_codes')
        .update({
          polar_sync_status: 'skipped',
          polar_sync_error:
            'POLAR_ACCESS_TOKEN is not set; code saved locally only',
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .select('*')
        .single();
      return data as DiscountCodeRow;
    }

    try {
      const polarId = row.polar_discount_id
        ? await this.polarService.updatePolarDiscount(row)
        : await this.polarService.createPolarDiscount(row);

      const { data, error } = await this.db()
        .from('discount_codes')
        .update({
          polar_discount_id: polarId,
          polar_sync_status: 'synced',
          polar_sync_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .select('*')
        .single();
      if (error) throw new BadGatewayException(error.message);
      return data as DiscountCodeRow;
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : 'Polar discount sync failed';
      this.logger.error(`Polar sync failed for ${row.code}: ${message}`);
      const { data } = await this.db()
        .from('discount_codes')
        .update({
          polar_sync_status: 'error',
          polar_sync_error: message.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .select('*')
        .single();
      throw new BadGatewayException({
        message: 'Discount saved but Polar sync failed',
        polarSyncError: message,
        row: data,
      });
    }
  }
}
