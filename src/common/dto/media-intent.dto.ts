import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum MediaPostType {
  SINGLE = 'single',
  CAROUSEL = 'carousel',
}

export class CarouselSlideDto {
  @IsString()
  @MaxLength(200)
  headline: string;

  @IsString()
  @MaxLength(500)
  body: string;

  @IsString()
  @MaxLength(1500)
  imagePrompt: string;
}

export class N8nGeneratedContentDto {
  @IsString()
  @MaxLength(180)
  title: string;

  @IsString()
  @MaxLength(5000)
  content: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  hashtags?: string[];

  @IsOptional()
  @IsEnum(MediaPostType)
  postType?: MediaPostType;

  @IsOptional()
  @IsString()
  @MaxLength(1500)
  imagePrompt?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CarouselSlideDto)
  slides?: CarouselSlideDto[];

  // Backward-compat fields from legacy n8n payloads.
  @IsOptional()
  @IsString()
  visualType?: string;

  @IsOptional()
  @IsString()
  visualUrl?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  carouselUrls?: string[];

  @IsOptional()
  aiScore?: number;

  @IsOptional()
  @IsString()
  aiReasoning?: string;
}

export class N8nCallbackDto {
  @IsString()
  jobId: string;

  @IsEnum(['success', 'failed'] as const)
  status: 'success' | 'failed';

  @IsOptional()
  @ValidateNested()
  @Type(() => N8nGeneratedContentDto)
  content?: N8nGeneratedContentDto;

  @IsOptional()
  @IsString()
  error?: string;
}
