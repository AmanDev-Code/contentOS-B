import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CustomTopicGenerationService } from './custom-topic-generation.service';
import { TrendingHashtagEngineService } from '../../services/trending-hashtag-engine.service';
import { TrendingTagsService } from '../../services/trending-tags.service';

@Module({
  imports: [ConfigModule],
  providers: [CustomTopicGenerationService],
  exports: [CustomTopicGenerationService],
})
export class PostAiModule {}
