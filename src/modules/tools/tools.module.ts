import { Module } from '@nestjs/common';
import { ToolsService } from './services/tools.service';
import { AutoCaptionModule } from './auto-caption';
import { InstagramReelDownloaderModule } from './instagram-reel-downloader';
import { BioGeneratorModule } from './bio-generator';
import { ImageToolsModule } from './image-tools';
import { AudioToolsModule } from './audio-tools';
import { VideoToolsModule } from './video-tools';

/**
 * Root Tools Module — imports all individual tool sub-modules.
 * Shared services (ToolsService, registry) live at this level.
 * Each tool is a self-contained module in its own folder.
 */
@Module({
  imports: [
    AutoCaptionModule,
    InstagramReelDownloaderModule,
    BioGeneratorModule,
    ImageToolsModule,
    AudioToolsModule,
    VideoToolsModule,
  ],
  providers: [ToolsService],
  exports: [ToolsService],
})
export class ToolsModule {}
