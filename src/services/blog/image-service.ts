"use strict";

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AiGatewayService } from '../ai-gateway.service';
import { MinioService } from '../minio.service';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { slugify } from '../../utils/slugify';
import { format } from 'date-fns';

// Test function for manual validation
function testGenerateFeatureImage() {
  const service = new BlogImageService(null as any, null as any, null as any);
  const testPost = {
    title: "How Trndinn's Brand Kit Ensures LinkedIn Posts Sound Like You",
    slug: "brand-kit-linkedin-consistency",
    keywords: ["brand voice", "LinkedIn", "AI posts"]
  };
  
  // Mock the prompt sanitization for testing
  console.log("Sanitized prompt:", service['sanitizePrompt'](
    service['buildPrompt'](testPost.title, testPost.keywords)
  ));
  
  // Test file name generation
  const fileName = service['generateFileName'](testPost.title, testPost.keywords?.[0]);
  console.log("Generated file name:", fileName);
  
  // Test alt text generation
  const altText = service['generateAltText'](testPost.title, testPost.keywords);
  console.log("Generated alt text:", altText);
}

/**
 * SEO-optimized image generation pipeline for blog posts.
 * Uses Bifrost (DALL·E) for generation, optimizes for web, stores in MinIO,
 * and handles SEO requirements like file naming/alt text.
 */
@Injectable()
export class BlogImageService implements OnModuleInit {
  private readonly logger = new Logger(BlogImageService.name);
  private readonly BUCKET_NAME = 'blog-images';
  private readonly MAX_IMAGE_SIZE_KB = 100;
  private readonly TARGET_WIDTH = 1200;
  private readonly TARGET_HEIGHT = 630;
  private readonly ASPECT_RATIO = this.TARGET_WIDTH / this.TARGET_HEIGHT;

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly minio: MinioService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureBucketExists();
    } catch (err) {
      this.logger.warn(`Could not ensure blog-images bucket on startup: ${err.message}`);
    }
  }

  /**
   * Generate a feature image for a blog post.
   * 1. Builds DALL·E prompt from post title + keywords
   * 2. Generates image via Bifrost
   * 3. Downloads, optimizes, uploads to MinIO
   * 4. Returns SEO-optimized path
   */
  async generateFeatureImage(post: {
    id: string;
    title: string;
    slug: string;
    keywords?: string[];
    excerpt?: string;
  }): Promise<string> {
    try {
      const prompt = this.buildPrompt(post.title, post.keywords);
      this.logger.debug(`Generating feature image for ${post.slug} with prompt: ${prompt}`);

      // Generate image via Bifrost with sanitized input
      const sanitizedPrompt = this.sanitizePrompt(prompt);
      const { b64, model } = await this.aiGateway.generateImageB64({
        prompt: sanitizedPrompt,
        size: '1200x630',
        quality: 'hd',
      });
      this.logger.debug(`Generated feature image using model ${model}`);

      // Optimize and upload
      const optimizedPath = await this.downloadAndOptimize(
        b64,
        post.slug,
        post.title,
      );

      return optimizedPath;
    } catch (error) {
      this.logger.error(`Failed to generate feature image: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Build an SEO-optimized DALL·E prompt from post title and keywords.
   * Follows Trndinn brand guidelines and avoids problematic elements.
   */
  private buildPrompt(title: string, keywords?: string[]): string {
    const keywordList = keywords?.length
      ? keywords.join(', ')
      : 'social media, content creation, AI agents, branding';

    return `Generate a professional feature image for the blog post titled: '${title}'.

Style requirements:
- Clean tech illustration with minimal text 
- Professional look suitable for SaaS/blog content
- Modern flat design style
- No faces or realistic human portraits
- Avoid copyrighted elements, cartoon characters, or brand logos

Color scheme:
- Primary: Trndinn brand orange (#FFA500) plus gradients
- Secondary: modern complementary colors
- Professional contrast for readability

Content requirements:
- Incorporate key concepts: ${keywordList}
- Design should visually represent the post's main message
- Minimal intrusive text (only small brand-appropriate typography if necessary)
- Suitable for 1200x630px (1.91:1 aspect ratio for social sharing)
- Avoid creating actual screenshots or UI mockups (illustration only)

Technical requirements:
- Final output must be >90% original content (no direct copies of existing images)
- PNG format with transparent background (if needed for flexibility)
- Web-optimized: avoid excessive fine details that are lost upon compression
- Safe for commercial use without attribution

Examples of what to include:
- Abstract representations of: ${this.extractKeyConcepts(title, keywords)}
- Brand-consistent UI elements, charts, icons, or diagrams
- Productivity themes, digital marketing concepts, or AI visualizations
`;
  }

  /**
   * Extract key concepts from title and keywords for prompt engineering.
   * Focuses on visualizable abstractions rather than literal interpretations.
   */
  private sanitizePrompt(prompt: string): string {
    // Remove characters that could cause issues in tool names, paths, or URLs
    return prompt.replace(/[^a-zA-Z0-9\s\-_,.()]/g, '');
  }

  private extractKeyConcepts(title: string, keywords?: string[]): string {
    const baseConcepts = ['AI automation', 'content strategy', 'branding', 'social media growth'];
    const titleConcepts = title.split(/\s+/)
      .filter(word => word.length > 3)
      .filter(word => !['the', 'and', 'with', 'for', 'from', 'how'].includes(word.toLowerCase()))
      .slice(0, 5);

    const allConcepts = [...titleConcepts, ...(keywords || [])];
    // Deduplicate and format
    const uniqueConcepts = [...new Set(allConcepts)].slice(0, 8);

    return uniqueConcepts.length > 0 ? uniqueConcepts.join(', ') : baseConcepts.join(', ');
  }

  /**
   * Generate SEO-optimized file name from primary keyword + post title.
   */
  private generateFileName(postTitle: string, primaryKeyword?: string): string {
    const today = format(new Date(), 'yyyyMMdd');
    const keyword = slugify(primaryKeyword || postTitle.split(' ')[0] || 'trndinn');
    const descriptor = slugify(postTitle.replace(/\(.*?\)/g, '')).substring(0, 40);
    
    // Remove duplicate keyword at start if present
    const cleanDescriptor = descriptor.startsWith(keyword)
      ? descriptor.substring(keyword.length).replace(/^-+/, '')
      : descriptor;
    
    return `${keyword}-${cleanDescriptor}-${today}.webp`.toLowerCase();
  }

  /**
   * Generate alt text from post title and keywords.
   * Follows screen reader best practices (concise, descriptive, ≤125 chars).
   */
  private generateAltText(title: string, keywords?: string[]): string {
    const primaryKeyword = keywords?.[0] || title.split(' ')[0] || 'Trndinn';
    const postContext = title.replace(/\(.*?\)/g, '').length > 80
      ? title.substring(0, 80).replace(/[,.!?]$/, '') + '...'
      : title;
    
    const altText = `${primaryKeyword}: ${postContext}`;
    // Enforce 125 char limit (screen reader best practice)
    return altText.length > 125 ? altText.substring(0, 124) : altText;
  }

  /**
   * Process DALL·E output: convert to WebP, compress, upload to MinIO.
   */
  private async downloadAndOptimize(
    b64Data: string,
    postSlug: string,
    postTitle: string,
    primaryKeyword?: string,
  ): Promise<string> {
    try {
      // Decode base64
      const buffer = Buffer.from(b64Data, 'base64');

      // Generate SEO-optimized file name and alt text
      const fileName = this.generateFileName(postTitle, primaryKeyword);
      const altText = this.generateAltText(postTitle, [primaryKeyword].filter(Boolean) as string[]);
      const objectName = `blog/${postSlug}/${fileName}`;

      // Process image with sharp: convert to WebP, resize maintaining aspect ratio, compress
      const processedBuffer = await sharp(buffer)
        .resize({
          width: this.TARGET_WIDTH,
          height: this.TARGET_HEIGHT,
          fit: 'cover',
          position: 'center',
        })
        .webp({
          quality: 80, 
          effort: 6, // Balance between compression and processing time
        })
        .toBuffer();

      // Upload to MinIO
      await this.minio.uploadFile(this.BUCKET_NAME, objectName, processedBuffer, 'image/webp');

      this.logger.log(`Successfully saved optimized image to MinIO: ${objectName}`);
      return objectName;
    } catch (error) {
      this.logger.error(`Image optimization failed: ${(error as Error).message}`);
      throw new Error(`Failed to process image: ${(error as Error).message}`);
    }
  }

  /**
   * Ensure MinIO bucket exists and is configured for public access.
   */
  private async ensureBucketExists(): Promise<void> {
    await this.minio.ensureBucketExists(this.BUCKET_NAME);
    this.logger.log(`Ensured MinIO bucket exists: ${this.BUCKET_NAME}`);
  }

  /**
   * Generate alt text for distribution platforms that use images.
   * Platforms like LinkedIn have specific image content expectations.
   */
  generatePlatformAltText(
    postTitle: string,
    platform: string,
    keywords?: string[],
  ): string {
    const baseAlt = this.generateAltText(postTitle, keywords);
    
    switch (platform.toLowerCase()) {
      case 'linkedin':
      case 'linkedin_article':
        return `Professional image illustrating: ${baseAlt}`;
      case 'twitter':
        return `Social media graphic: ${baseAlt}`;
      case 'newsletter':
        return `Newsletter feature image: ${baseAlt}`;
      default:
        return baseAlt;
    }
  }

  /**
   * Manual regeneration endpoint: force regeneration of a feature image.
   */
  async regenerateFeatureImage(post: {
    id: string;
    title: string;
    slug: string;
    keywords?: string[];
    existingImageUrl?: string;
  }): Promise<string> {
    try {
      // Optionally delete existing image
      if (post.existingImageUrl) {
        try {
          await this.deleteImage(post.existingImageUrl);
        } catch (deleteError) {
          this.logger.warn(`Failed to delete existing image: ${(deleteError as Error).message}`);
        }
      }

      // Generate new image
      return await this.generateFeatureImage(post);
    } catch (error) {
      this.logger.error(`Image regeneration failed: ${(error as Error).message}`);
      // Fallback to placeholder if generation fails
      return `/blog-images/placeholders/${post.slug}.webp`;
    }
  }

  /**
   * Delete an image from MinIO
   */
  async deleteImage(objectName: string): Promise<void> {
    await this.minio.deleteFile(this.BUCKET_NAME, objectName);
    this.logger.log(`Deleted image from MinIO: ${objectName}`);
  }

  /**
   * Validate SEO requirements for generated images.
   * Used in pre-publish validation.
   */
  async validateImageSeo(
    objectName: string,
    expectedPost: {
      slug: string;
      title: string;
      keywords?: string[];
    },
  ): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Validate bucket structure
    const expectedPath = `blog/${expectedPost.slug}/`;
    if (!objectName.startsWith(expectedPath)) {
      errors.push(`Image not stored in correct path: expected ${expectedPath}`);
    }

    // Validate file extension
    if (!objectName.endsWith('.webp')) {
      errors.push('Image not in WebP format');
    }

    try {
      // Check file size
      const stats = await this.minio.getFileStats(this.BUCKET_NAME, objectName);
      if (stats.size > this.MAX_IMAGE_SIZE_KB * 1024) {
        errors.push(`Image exceeds maximum size of ${this.MAX_IMAGE_SIZE_KB}KB.`);
      }

      // Alt text validation is skipped since metadata is not stored separately
      const altText = undefined;
      if (!altText) {
        errors.push('Missing alt text in image metadata');
      } else {
        // Decode alt text and validate
        const decodedAlt = decodeURIComponent(altText);
        if (decodedAlt.length > 125) {
          errors.push('Alt text exceeds 125 character limit (screen reader best practice)');
        }
        
        // Check if alt text contains primary keyword
        const primaryKeyword = expectedPost.keywords?.[0] || expectedPost.title.split(' ')[0];
        if (primaryKeyword && !decodedAlt.toLowerCase().includes(primaryKeyword.toLowerCase())) {
          errors.push('Alt text does not contain primary keyword');
        }
      }
    } catch (error) {
      errors.push(`Failed to validate image: ${(error as Error).message}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}