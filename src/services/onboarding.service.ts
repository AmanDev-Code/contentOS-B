import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from './supabase.service';

type OnboardingAnswers = {
  role?: string;
  goal?: string;
  teamSize?: string;
  postingFrequency?: string;
  focusArea?: string;
  referralSource?: string;
};

export type OnboardingQuestionOption = {
  value: string;
  label: string;
  icon?: string;
};

export type OnboardingQuestion = {
  id: string;
  step_number: number;
  question_text: string;
  question_key: string;
  options: OnboardingQuestionOption[];
  is_required: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type OnboardingResponse = {
  id: string;
  user_id: string;
  question_id: string;
  selected_option: string | Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

// DTO classes for NestJS decorator metadata
export class CreateQuestionDto {
  step_number: number;
  question_text: string;
  question_key: string;
  options: OnboardingQuestionOption[];
  is_required?: boolean;
  is_active?: boolean;
}

export class UpdateQuestionDto {
  step_number?: number;
  question_text?: string;
  question_key?: string;
  options?: OnboardingQuestionOption[];
  is_required?: boolean;
  is_active?: boolean;
}

type OnboardingStatus = {
  required: boolean;
  enabled: boolean;
  completed: boolean;
  activationCompleted: boolean;
  activationFlowEnabled: boolean;
  tourCompleted: boolean;
  enabledAt: string | null;
  questionVersion: number;
  tourVersion: number;
  tourSteps: Record<string, boolean>;
  linkedInConnected: boolean;
};

@Injectable()
export class OnboardingService {
  private readonly flagKey = 'onboarding_v1';

  constructor(private readonly supabaseService: SupabaseService) {}

  async getConfig(): Promise<{
    enabled: boolean;
    enabledAt: string | null;
    questionVersion: number;
    tourVersion: number;
    tourSteps: Record<string, boolean>;
    activationFlowEnabled: boolean;
  }> {
    const client = this.supabaseService.getServiceClient();
    const { data } = await client
      .from('feature_flags')
      .select('enabled, config')
      .eq('key', this.flagKey)
      .maybeSingle();

    const config = (data?.config as Record<string, any> | null) || {};
    const tourStepsRaw = (config.tourSteps as Record<string, any> | null) || {};
    return {
      enabled: Boolean(data?.enabled),
      enabledAt:
        typeof config.enabledAt === 'string' && config.enabledAt
          ? config.enabledAt
          : null,
      questionVersion: Number(config.questionVersion || 1),
      tourVersion: Number(config.tourVersion || 1),
      tourSteps: {
        dashboard: tourStepsRaw.dashboard !== false,
        createPost: tourStepsRaw.createPost !== false,
        generationDemo: tourStepsRaw.generationDemo !== false,
        scheduledPosts: tourStepsRaw.scheduledPosts !== false,
        media: tourStepsRaw.media !== false,
        settings: tourStepsRaw.settings !== false,
        notificationsBell: tourStepsRaw.notificationsBell !== false,
      },
      // Default to true (activation flow is the default experience)
      activationFlowEnabled: config.activationFlowEnabled !== false,
    };
  }

  async updateConfig(input: {
    enabled?: boolean;
    enabledAt?: string | null;
    questionVersion?: number;
    tourVersion?: number;
    tourSteps?: Record<string, boolean>;
  }) {
    const current = await this.getConfig();
    const enabled = input.enabled ?? current.enabled;

    // When enabling without explicit timestamp, set "now".
    const enabledAt =
      input.enabledAt !== undefined
        ? input.enabledAt
        : enabled && !current.enabledAt
          ? new Date().toISOString()
          : current.enabledAt;

    const config = {
      enabledAt,
      questionVersion: input.questionVersion ?? current.questionVersion,
      tourVersion: input.tourVersion ?? current.tourVersion,
      tourSteps: input.tourSteps ?? current.tourSteps,
    };

    await this.supabaseService.getServiceClient().from('feature_flags').upsert(
      {
        key: this.flagKey,
        enabled,
        config,
      },
      { onConflict: 'key' },
    );

    return { enabled, ...config };
  }

  async getStatus(userId: string): Promise<OnboardingStatus> {
    const [cfg, profileRes, userRes, linkedInRes] = await Promise.all([
      this.getConfig(),
      this.supabaseService
        .getServiceClient()
        .from('profiles')
        .select('preferences')
        .eq('id', userId)
        .maybeSingle(),
      this.supabaseService.getServiceClient().auth.admin.getUserById(userId),
      this.supabaseService
        .getServiceClient()
        .from('social_accounts')
        .select('id')
        .eq('user_id', userId)
        .eq('provider', 'linkedin')
        .maybeSingle(),
    ]);

    const preferences =
      (profileRes.data?.preferences as Record<string, any> | null) || {};
    const onboarding = (preferences.onboarding as Record<string, any>) || {};

    const completed = Boolean(onboarding.completed);
    const activationCompleted = Boolean(onboarding.activationCompleted);
    const tourCompleted = Boolean(onboarding.tourCompleted);
    const userCreatedAt = userRes.data?.user?.created_at || null;

    const isAfterEnablement =
      !!cfg.enabledAt &&
      !!userCreatedAt &&
      new Date(userCreatedAt).getTime() >= new Date(cfg.enabledAt).getTime();

    const required = Boolean(cfg.enabled && isAfterEnablement && !completed);

    // Activation flow is the default — the flag config can override
    // to legacy questions mode via config.activationFlow = false
    const activationFlowEnabled = cfg.activationFlowEnabled !== false;

    return {
      required,
      enabled: cfg.enabled,
      completed,
      activationCompleted,
      activationFlowEnabled,
      tourCompleted,
      enabledAt: cfg.enabledAt,
      questionVersion: cfg.questionVersion,
      tourVersion: cfg.tourVersion,
      tourSteps: cfg.tourSteps,
      linkedInConnected: Boolean(linkedInRes.data),
    };
  }

  async completeOnboarding(userId: string, answers: OnboardingAnswers) {
    const client = this.supabaseService.getServiceClient();
    const { data: profile } = await client
      .from('profiles')
      .select('preferences')
      .eq('id', userId)
      .maybeSingle();

    const preferences = (profile?.preferences as Record<string, any>) || {};
    const onboarding = (preferences.onboarding as Record<string, any>) || {};

    const nextPreferences = {
      ...preferences,
      onboarding: {
        ...onboarding,
        completed: true,
        completedAt: new Date().toISOString(),
        answers: {
          ...(onboarding.answers || {}),
          ...answers,
        },
      },
    };

    await client
      .from('profiles')
      .update({
        preferences: nextPreferences,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    return { success: true };
  }

  async completeTour(userId: string) {
    const client = this.supabaseService.getServiceClient();
    const { data: profile } = await client
      .from('profiles')
      .select('preferences')
      .eq('id', userId)
      .maybeSingle();

    const preferences = (profile?.preferences as Record<string, any>) || {};
    const onboarding = (preferences.onboarding as Record<string, any>) || {};

    const nextPreferences = {
      ...preferences,
      onboarding: {
        ...onboarding,
        tourCompleted: true,
        tourCompletedAt: new Date().toISOString(),
      },
    };

    await client
      .from('profiles')
      .update({
        preferences: nextPreferences,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    return { success: true };
  }

  async completeActivation(userId: string) {
    const client = this.supabaseService.getServiceClient();
    const { data: profile } = await client
      .from('profiles')
      .select('preferences')
      .eq('id', userId)
      .maybeSingle();

    const preferences = (profile?.preferences as Record<string, any>) || {};
    const onboarding = (preferences.onboarding as Record<string, any>) || {};

    const nextPreferences = {
      ...preferences,
      onboarding: {
        ...onboarding,
        activationCompleted: true,
        activationCompletedAt: new Date().toISOString(),
        // Also mark as "completed" so the wizard doesn't re-appear
        completed: true,
        completedAt: onboarding.completedAt || new Date().toISOString(),
      },
    };

    await client
      .from('profiles')
      .update({
        preferences: nextPreferences,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    return { success: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // QUESTIONS MANAGEMENT (Admin)
  // ═══════════════════════════════════════════════════════════════════════════

  async listAllQuestions(): Promise<OnboardingQuestion[]> {
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('onboarding_questions')
      .select('*')
      .order('step_number', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch questions: ${error.message}`);
    }

    return (data || []) as OnboardingQuestion[];
  }

  async listActiveQuestions(): Promise<OnboardingQuestion[]> {
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('onboarding_questions')
      .select('*')
      .eq('is_active', true)
      .order('step_number', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch active questions: ${error.message}`);
    }

    return (data || []) as OnboardingQuestion[];
  }

  async getQuestionById(id: string): Promise<OnboardingQuestion> {
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('onboarding_questions')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to fetch question: ${error.message}`);
    }

    if (!data) {
      throw new NotFoundException(`Question with id ${id} not found`);
    }

    return data as OnboardingQuestion;
  }

  async createQuestion(dto: CreateQuestionDto): Promise<OnboardingQuestion> {
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('onboarding_questions')
      .insert({
        step_number: dto.step_number,
        question_text: dto.question_text,
        question_key: dto.question_key,
        options: dto.options,
        is_required: dto.is_required ?? true,
        is_active: dto.is_active ?? true,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create question: ${error.message}`);
    }

    return data as OnboardingQuestion;
  }

  async updateQuestion(
    id: string,
    dto: UpdateQuestionDto,
  ): Promise<OnboardingQuestion> {
    const client = this.supabaseService.getServiceClient();

    const updateData: Record<string, unknown> = {};
    if (dto.step_number !== undefined) updateData.step_number = dto.step_number;
    if (dto.question_text !== undefined)
      updateData.question_text = dto.question_text;
    if (dto.question_key !== undefined)
      updateData.question_key = dto.question_key;
    if (dto.options !== undefined) updateData.options = dto.options;
    if (dto.is_required !== undefined) updateData.is_required = dto.is_required;
    if (dto.is_active !== undefined) updateData.is_active = dto.is_active;

    const { data, error } = await client
      .from('onboarding_questions')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update question: ${error.message}`);
    }

    if (!data) {
      throw new NotFoundException(`Question with id ${id} not found`);
    }

    return data as OnboardingQuestion;
  }

  async deleteQuestion(id: string): Promise<void> {
    const client = this.supabaseService.getServiceClient();
    const { error } = await client
      .from('onboarding_questions')
      .delete()
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to delete question: ${error.message}`);
    }
  }

  async reorderQuestions(
    questionOrders: { id: string; step_number: number }[],
  ): Promise<OnboardingQuestion[]> {
    const client = this.supabaseService.getServiceClient();

    for (const item of questionOrders) {
      const { error } = await client
        .from('onboarding_questions')
        .update({ step_number: item.step_number })
        .eq('id', item.id);

      if (error) {
        throw new Error(`Failed to reorder question ${item.id}: ${error.message}`);
      }
    }

    return this.listAllQuestions();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESPONSES MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  async saveResponse(
    userId: string,
    questionId: string,
    selectedOption: string | Record<string, unknown>,
  ): Promise<OnboardingResponse> {
    const client = this.supabaseService.getServiceClient();

    const { data, error } = await client
      .from('onboarding_responses')
      .upsert(
        {
          user_id: userId,
          question_id: questionId,
          selected_option: selectedOption,
        },
        { onConflict: 'user_id,question_id' },
      )
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to save response: ${error.message}`);
    }

    return data as OnboardingResponse;
  }

  async saveAllResponses(
    userId: string,
    responses: { questionId: string; selectedOption: string }[],
  ): Promise<OnboardingResponse[]> {
    const client = this.supabaseService.getServiceClient();

    const records = responses.map((r) => ({
      user_id: userId,
      question_id: r.questionId,
      selected_option: r.selectedOption,
    }));

    const { data, error } = await client
      .from('onboarding_responses')
      .upsert(records, { onConflict: 'user_id,question_id' })
      .select();

    if (error) {
      throw new Error(`Failed to save responses: ${error.message}`);
    }

    return (data || []) as OnboardingResponse[];
  }

  async getUserResponses(userId: string): Promise<
    Array<{
      response: OnboardingResponse;
      question: OnboardingQuestion;
    }>
  > {
    const client = this.supabaseService.getServiceClient();

    const { data, error } = await client
      .from('onboarding_responses')
      .select(
        `
        *,
        question:onboarding_questions(*)
      `,
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch user responses: ${error.message}`);
    }

    return (data || []).map((row: any) => ({
      response: {
        id: row.id,
        user_id: row.user_id,
        question_id: row.question_id,
        selected_option: row.selected_option,
        created_at: row.created_at,
        updated_at: row.updated_at,
      } as OnboardingResponse,
      question: row.question as OnboardingQuestion,
    }));
  }

  async getUserResponsesForAdmin(userId: string): Promise<
    Array<{
      questionText: string;
      questionKey: string;
      selectedValue: string;
      selectedLabel: string;
      answeredAt: string;
    }>
  > {
    const responses = await this.getUserResponses(userId);

    return responses.map((r) => {
      const selectedValue =
        typeof r.response.selected_option === 'string'
          ? r.response.selected_option
          : JSON.stringify(r.response.selected_option);

      const options = r.question?.options || [];
      const matchedOption = options.find(
        (opt: OnboardingQuestionOption) => opt.value === selectedValue,
      );

      return {
        questionText: r.question?.question_text || 'Unknown question',
        questionKey: r.question?.question_key || 'unknown',
        selectedValue,
        selectedLabel: matchedOption?.label || selectedValue,
        answeredAt: r.response.created_at,
      };
    });
  }

  async hasUserCompletedOnboarding(userId: string): Promise<boolean> {
    const client = this.supabaseService.getServiceClient();

    const { count: requiredCount } = await client
      .from('onboarding_questions')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true)
      .eq('is_required', true);

    const { count: responseCount } = await client
      .from('onboarding_responses')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    return (responseCount || 0) >= (requiredCount || 0);
  }
}
