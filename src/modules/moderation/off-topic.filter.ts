import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
} from '@nestjs/common';
import { Response } from 'express';
import { OffTopicError } from '../post-ai/errors';

@Catch(OffTopicError)
export class OffTopicExceptionFilter implements ExceptionFilter {
  catch(_exception: OffTopicError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    response.status(422).json({
      statusCode: 422,
      code: 'off_topic',
      message:
        'Please describe a topic, event, or experience for your post.',
    });
  }
}
