/**
 * DTOs for the bio-generator controller. class-validator enforces shape at the
 * Fastify boundary — see backend/src/main.ts for ValidationPipe registration.
 */

import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { BIO_PLATFORMS, BIO_TONES } from '../config';
import type { BioPlatform, BioTone } from '../config';

const FOCUS_AREAS = [
  'achievements',
  'skills',
  'personality',
  'mission',
  'creativity',
  'leadership',
  'credibility',
  'contrarian',
] as const;

const MODEL_PREFERENCES = ['fast', 'balanced', 'best', 'creative', 'reasoning'] as const;

export class GenerateBioDto {
  @IsString()
  @MinLength(3, { message: 'role must be at least 3 characters' })
  @MaxLength(400, { message: 'role must be at most 400 characters' })
  role!: string;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  facts?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  goal?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  audience?: string;

  @IsOptional()
  @IsIn(['short', 'medium', 'long'])
  length?: 'short' | 'medium' | 'long';

  @IsOptional()
  @IsBoolean()
  emojis?: boolean;

  @IsArray()
  @ArrayMinSize(1, { message: 'select at least one platform' })
  @ArrayMaxSize(BIO_PLATFORMS.length)
  @IsIn(BIO_PLATFORMS as unknown as string[], { each: true })
  platforms!: BioPlatform[];

  @IsIn(BIO_TONES as unknown as string[])
  tone!: BioTone;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  variations?: number;

  @IsOptional()
  @IsIn(['personal', 'brand'])
  bioType?: 'personal' | 'brand';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(FOCUS_AREAS.length)
  @IsIn(FOCUS_AREAS as unknown as string[], { each: true })
  focusAreas?: string[];

  @IsOptional()
  @IsIn(MODEL_PREFERENCES as unknown as string[])
  modelPreference?: (typeof MODEL_PREFERENCES)[number];
}

export class ScoreBioDto {
  @IsString()
  @MinLength(10)
  @MaxLength(3000)
  text!: string;

  @IsIn(BIO_PLATFORMS as unknown as string[])
  platform!: BioPlatform;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  goal?: string;
}
