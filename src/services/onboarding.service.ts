import { Injectable } from '@nestjs/common';
import { SupabaseService } from './supabase.service';

type OnboardingAnswers = {
  role?: string;
  goal?: string;
  teamSize?: string;
  postingFrequency?: string;
  focusArea?: string;
  referralSource?: string;
};

type OnboardingStatus = {
  required: boolean;
  enabled: boolean;
  completed: boolean;
  tourCompleted: boolean;
  enabledAt: string | null;
  questionVersion: number;
  tourVersion: number;
  tourSteps: Record<string, boolean>;
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
    const [cfg, profileRes, userRes] = await Promise.all([
      this.getConfig(),
      this.supabaseService
        .getServiceClient()
        .from('profiles')
        .select('preferences')
        .eq('id', userId)
        .maybeSingle(),
      this.supabaseService
        .getServiceClient()
        .auth.admin.getUserById(userId),
    ]);

    const preferences =
      (profileRes.data?.preferences as Record<string, any> | null) || {};
    const onboarding = (preferences.onboarding as Record<string, any>) || {};

    const completed = Boolean(onboarding.completed);
    const tourCompleted = Boolean(onboarding.tourCompleted);
    const userCreatedAt = userRes.data?.user?.created_at || null;

    const isAfterEnablement =
      !!cfg.enabledAt &&
      !!userCreatedAt &&
      new Date(userCreatedAt).getTime() >= new Date(cfg.enabledAt).getTime();

    const required = Boolean(cfg.enabled && isAfterEnablement && !completed);

    return {
      required,
      enabled: cfg.enabled,
      completed,
      tourCompleted,
      enabledAt: cfg.enabledAt,
      questionVersion: cfg.questionVersion,
      tourVersion: cfg.tourVersion,
      tourSteps: cfg.tourSteps,
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
}
