import { Module } from '@nestjs/common';
import { CustomTopicCreditService } from './custom-topic-credit.service';

@Module({
  providers: [CustomTopicCreditService],
  exports: [CustomTopicCreditService],
})
export class CreditsModule {}
