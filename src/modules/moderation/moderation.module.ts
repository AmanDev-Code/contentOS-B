import { Module } from '@nestjs/common';
import { ModerationService } from './moderation.service';
import { SupabaseService } from '../../services/supabase.service';
import { NotificationService } from '../../services/notification.service';

@Module({
  providers: [ModerationService, SupabaseService, NotificationService],
  exports: [ModerationService],
})
export class ModerationModule {}
