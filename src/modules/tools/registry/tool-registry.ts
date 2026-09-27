import { ToolDefinition } from './tool.types';

/**
 * Master registry of all free tools.
 *
 * Adding a tool here is the single source of truth for:
 * - Route existence
 * - Rate limit category assignment
 * - SEO metadata
 * - Tool status (maintenance mode, etc.)
 */
export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  // ─── Existing tools ───────────────────────────────────────────────────────

  'instagram-reel-downloader': {
    slug: 'instagram-reel-downloader',
    name: 'Instagram Reel Downloader',
    description:
      'Download Instagram Reels in HD quality. Free, no login required. Paste the reel URL and get the direct video link instantly.',
    category: 'utility',
    status: 'active',
    keywords: [
      'instagram reel downloader',
      'download instagram reels',
      'ig reel download',
      'save instagram reels',
      'instagram video downloader',
    ],
    searchVolume: 110000,
  },
  'auto-caption-generator': {
    slug: 'auto-caption-generator',
    name: 'Auto Caption Generator',
    description:
      'Add auto-synced captions to any video for free. AI transcribes, syncs word-by-word, and burns styled subtitles onto your Reels, Shorts, and TikToks.',
    category: 'file-processing-heavy',
    status: 'active',
    keywords: [
      'auto caption generator',
      'auto caption generator for video',
      'add captions to video free',
      'subtitle generator online',
      'auto subtitles for reels',
      'video caption maker',
      'burn subtitles into video',
    ],
    searchVolume: 49000,
  },
  'bio-generator': {
    slug: 'bio-generator',
    name: 'Bio Generator',
    description:
      'Generate a compelling LinkedIn or social media bio in seconds using AI. Free, no signup required.',
    category: 'text-ai',
    status: 'active',
    keywords: [
      'bio generator',
      'linkedin bio generator',
      'social media bio generator',
      'ai bio writer',
    ],
    searchVolume: 22000,
  },

  // ─── Image Conversion (33 tools) ──────────────────────────────────────────

  'png-to-jpg': { slug: 'png-to-jpg', name: 'PNG to JPG Converter', description: 'Convert PNG images to JPG/JPEG format online free. No signup, instant download. Works in your browser.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['png'], outputFormats: ['jpg'], keywords: ['png to jpg', 'png to jpeg', 'convert png to jpg', 'png jpg converter online'], searchVolume: 74000 },
  'jpg-to-png': { slug: 'jpg-to-png', name: 'JPG to PNG Converter', description: 'Convert JPG/JPEG images to PNG format online free. Transparent background support. No signup required.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['jpg', 'jpeg'], outputFormats: ['png'], keywords: ['jpg to png', 'jpeg to png', 'convert jpg to png'], searchVolume: 40000 },
  'webp-to-jpg': { slug: 'webp-to-jpg', name: 'WEBP to JPG Converter', description: 'Convert WEBP images to JPG format online free. Instant, no upload to server, no signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['webp'], outputFormats: ['jpg'], keywords: ['webp to jpg', 'convert webp to jpg', 'webp to jpeg'], searchVolume: 33000 },
  'webp-to-png': { slug: 'webp-to-png', name: 'WEBP to PNG Converter', description: 'Convert WEBP to PNG online free. Preserves transparency. Browser-based, no file upload.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['webp'], outputFormats: ['png'], keywords: ['webp to png', 'convert webp to png'], searchVolume: 22000 },
  'jpg-to-webp': { slug: 'jpg-to-webp', name: 'JPG to WEBP Converter', description: 'Convert JPG to WEBP format online free. Smaller file sizes, same quality. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['jpg', 'jpeg'], outputFormats: ['webp'], keywords: ['jpg to webp', 'jpeg to webp', 'convert jpg to webp'], searchVolume: 18000 },
  'png-to-webp': { slug: 'png-to-webp', name: 'PNG to WEBP Converter', description: 'Convert PNG to WEBP online free. Reduce image file size without quality loss. Browser-based.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['png'], outputFormats: ['webp'], keywords: ['png to webp', 'convert png to webp'], searchVolume: 14000 },
  'heic-to-jpg': { slug: 'heic-to-jpg', name: 'HEIC to JPG Converter', description: 'Convert iPhone HEIC photos to JPG online free. No software install. Works in any browser.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['heic', 'heif'], outputFormats: ['jpg'], keywords: ['heic to jpg', 'heif to jpg', 'convert heic to jpg', 'iphone photo converter'], searchVolume: 110000 },
  'heic-to-png': { slug: 'heic-to-png', name: 'HEIC to PNG Converter', description: 'Convert iPhone HEIC photos to PNG online free. Preserves transparency. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['heic', 'heif'], outputFormats: ['png'], keywords: ['heic to png', 'heif to png', 'convert heic to png'], searchVolume: 22000 },
  'svg-to-png': { slug: 'svg-to-png', name: 'SVG to PNG Converter', description: 'Convert SVG vector files to PNG raster images online free. Custom dimensions. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['svg'], outputFormats: ['png'], keywords: ['svg to png', 'convert svg to png', 'svg png converter'], searchVolume: 40000 },
  'gif-to-jpg': { slug: 'gif-to-jpg', name: 'GIF to JPG Converter', description: 'Convert GIF to JPG online free. Extracts first frame. Browser-based, no upload.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['gif'], outputFormats: ['jpg'], keywords: ['gif to jpg', 'convert gif to jpg'], searchVolume: 8000 },
  'gif-to-png': { slug: 'gif-to-png', name: 'GIF to PNG Converter', description: 'Convert GIF to PNG online free. Preserves transparency. No signup, instant download.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['gif'], outputFormats: ['png'], keywords: ['gif to png', 'convert gif to png'], searchVolume: 8000 },
  'gif-to-webp': { slug: 'gif-to-webp', name: 'GIF to WEBP Converter', description: 'Convert GIF to WEBP format online free. Modern format, better compression. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['gif'], outputFormats: ['webp'], keywords: ['gif to webp', 'convert gif to webp'], searchVolume: 4000 },
  'bmp-to-jpg': { slug: 'bmp-to-jpg', name: 'BMP to JPG Converter', description: 'Convert BMP bitmap images to JPG online free. Reduce file size significantly. Browser-based.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['bmp'], outputFormats: ['jpg'], keywords: ['bmp to jpg', 'convert bmp to jpg', 'bmp to jpeg'], searchVolume: 6000 },
  'bmp-to-png': { slug: 'bmp-to-png', name: 'BMP to PNG Converter', description: 'Convert BMP to PNG online free. Lossless conversion with transparency support. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['bmp'], outputFormats: ['png'], keywords: ['bmp to png', 'convert bmp to png'], searchVolume: 4000 },
  'tiff-to-jpg': { slug: 'tiff-to-jpg', name: 'TIFF to JPG Converter', description: 'Convert TIFF images to JPG online free. For print-quality to web-ready conversion. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['tiff', 'tif'], outputFormats: ['jpg'], keywords: ['tiff to jpg', 'tif to jpg', 'convert tiff to jpg'], searchVolume: 12000 },
  'tiff-to-png': { slug: 'tiff-to-png', name: 'TIFF to PNG Converter', description: 'Convert TIFF to PNG online free. Preserves image quality. Browser-based, no upload.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['tiff', 'tif'], outputFormats: ['png'], keywords: ['tiff to png', 'tif to png', 'convert tiff to png'], searchVolume: 8000 },
  'jpg-to-avif': { slug: 'jpg-to-avif', name: 'JPG to AVIF Converter', description: 'Convert JPG to AVIF next-gen format online free. Superior compression vs JPG and WEBP. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['jpg', 'jpeg'], outputFormats: ['avif'], keywords: ['jpg to avif', 'jpeg to avif', 'convert jpg to avif'], searchVolume: 6000 },
  'png-to-avif': { slug: 'png-to-avif', name: 'PNG to AVIF Converter', description: 'Convert PNG to AVIF format online free. Next-gen compression, preserves transparency. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['png'], outputFormats: ['avif'], keywords: ['png to avif', 'convert png to avif'], searchVolume: 4000 },
  'webp-to-avif': { slug: 'webp-to-avif', name: 'WEBP to AVIF Converter', description: 'Convert WEBP to AVIF online free. Ultra-efficient compression for modern browsers. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['webp'], outputFormats: ['avif'], keywords: ['webp to avif', 'convert webp to avif'], searchVolume: 3000 },
  'avif-to-jpg': { slug: 'avif-to-jpg', name: 'AVIF to JPG Converter', description: 'Convert AVIF to JPG online free. For maximum browser compatibility. No signup, instant.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['avif'], outputFormats: ['jpg'], keywords: ['avif to jpg', 'convert avif to jpg', 'avif to jpeg'], searchVolume: 8000 },
  'avif-to-png': { slug: 'avif-to-png', name: 'AVIF to PNG Converter', description: 'Convert AVIF to PNG online free. Lossless output with full transparency. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['avif'], outputFormats: ['png'], keywords: ['avif to png', 'convert avif to png'], searchVolume: 4000 },
  'jpg-to-gif': { slug: 'jpg-to-gif', name: 'JPG to GIF Converter', description: 'Convert JPG to GIF online free. 256-color palette. Browser-based, no upload to server.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['jpg', 'jpeg'], outputFormats: ['gif'], keywords: ['jpg to gif', 'jpeg to gif', 'convert jpg to gif'], searchVolume: 4000 },
  'png-to-gif': { slug: 'png-to-gif', name: 'PNG to GIF Converter', description: 'Convert PNG to GIF online free. Transparency to 1-bit alpha. No signup required.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['png'], outputFormats: ['gif'], keywords: ['png to gif', 'convert png to gif'], searchVolume: 6000 },
  'webp-to-gif': { slug: 'webp-to-gif', name: 'WEBP to GIF Converter', description: 'Convert WEBP to GIF online free. Browser-based, instant download, no signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['webp'], outputFormats: ['gif'], keywords: ['webp to gif', 'convert webp to gif'], searchVolume: 3000 },
  'jpg-to-bmp': { slug: 'jpg-to-bmp', name: 'JPG to BMP Converter', description: 'Convert JPG to BMP uncompressed bitmap online free. For legacy software compatibility.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['jpg', 'jpeg'], outputFormats: ['bmp'], keywords: ['jpg to bmp', 'jpeg to bmp', 'convert jpg to bmp'], searchVolume: 3000 },
  'png-to-bmp': { slug: 'png-to-bmp', name: 'PNG to BMP Converter', description: 'Convert PNG to BMP online free. Uncompressed bitmap output. Browser-based, no signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['png'], outputFormats: ['bmp'], keywords: ['png to bmp', 'convert png to bmp'], searchVolume: 2000 },
  'webp-to-bmp': { slug: 'webp-to-bmp', name: 'WEBP to BMP Converter', description: 'Convert WEBP to BMP online free. Legacy format compatibility. No signup, instant download.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['webp'], outputFormats: ['bmp'], keywords: ['webp to bmp', 'convert webp to bmp'], searchVolume: 1000 },
  'jpg-to-tiff': { slug: 'jpg-to-tiff', name: 'JPG to TIFF Converter', description: 'Convert JPG to TIFF archival format online free. High-quality output for print. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['jpg', 'jpeg'], outputFormats: ['tiff'], keywords: ['jpg to tiff', 'jpeg to tiff', 'convert jpg to tiff'], searchVolume: 4000 },
  'png-to-tiff': { slug: 'png-to-tiff', name: 'PNG to TIFF Converter', description: 'Convert PNG to TIFF online free. With alpha channel support. Browser-based, no upload.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['png'], outputFormats: ['tiff'], keywords: ['png to tiff', 'convert png to tiff'], searchVolume: 3000 },
  'webp-to-tiff': { slug: 'webp-to-tiff', name: 'WEBP to TIFF Converter', description: 'Convert WEBP to TIFF print-quality format online free. No signup, instant download.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['webp'], outputFormats: ['tiff'], keywords: ['webp to tiff', 'convert webp to tiff'], searchVolume: 1000 },
  'png-to-ico': { slug: 'png-to-ico', name: 'PNG to ICO Converter', description: 'Convert PNG to ICO favicon format online free. Multi-resolution support. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['png'], outputFormats: ['ico'], keywords: ['png to ico', 'png to favicon', 'convert png to ico'], searchVolume: 18000 },
  'jpg-to-ico': { slug: 'jpg-to-ico', name: 'JPG to ICO Converter', description: 'Convert JPG to ICO favicon format online free. White background auto-added. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['jpg', 'jpeg'], outputFormats: ['ico'], keywords: ['jpg to ico', 'jpeg to ico', 'convert jpg to ico'], searchVolume: 6000 },
  'webp-to-ico': { slug: 'webp-to-ico', name: 'WEBP to ICO Converter', description: 'Convert WEBP to ICO favicon format online free. Browser-based, instant, no signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['webp'], outputFormats: ['ico'], keywords: ['webp to ico', 'convert webp to ico'], searchVolume: 3000 },

  // ─── Image Compression (4 tools) ─────────────────────────────────────────

  'compress-jpg': { slug: 'compress-jpg', name: 'Compress JPG', description: 'Compress JPG images online free. Adjustable quality slider. Reduce file size without visible loss. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['jpg', 'jpeg'], outputFormats: ['jpg'], keywords: ['compress jpg', 'compress jpeg', 'jpg compressor online', 'reduce jpg size'], searchVolume: 40000 },
  'compress-png': { slug: 'compress-png', name: 'Compress PNG', description: 'Compress PNG images online free. Lossy and lossless modes. Reduce file size, keep transparency. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['png'], outputFormats: ['png'], keywords: ['compress png', 'png compressor', 'reduce png file size'], searchVolume: 33000 },
  'compress-webp': { slug: 'compress-webp', name: 'Compress WEBP', description: 'Compress WEBP images online free. Quality control slider. Browser-based, no upload.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['webp'], outputFormats: ['webp'], keywords: ['compress webp', 'webp compressor', 'reduce webp size'], searchVolume: 8000 },
  'compress-gif': { slug: 'compress-gif', name: 'Compress GIF', description: 'Compress GIF files online free. Color palette optimization. Reduce animated GIF size. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['gif'], outputFormats: ['gif'], keywords: ['compress gif', 'gif compressor', 'reduce gif size'], searchVolume: 6000 },

  // ─── Image Edit (5 tools) ─────────────────────────────────────────────────

  'image-resizer': { slug: 'image-resizer', name: 'Image Resizer', description: 'Resize images to exact dimensions or social media presets. LinkedIn, Instagram, YouTube. Free, instant, no login.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'], outputFormats: ['jpg', 'png', 'webp'], keywords: ['image resizer free', 'resize image online', 'image resizer online free', 'photo resizer'], searchVolume: 40500 },
  'image-cropper': { slug: 'image-cropper', name: 'Image Cropper', description: 'Crop images online free. Free-form crop or preset aspect ratios. Browser-based, no signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'], outputFormats: ['jpg', 'png', 'webp'], keywords: ['image cropper', 'crop image online', 'crop photo online free'], searchVolume: 22000 },
  'image-rotator': { slug: 'image-rotator', name: 'Image Rotator', description: 'Rotate images online free. 90°, 180°, 270° or custom angle. EXIF orientation auto-correct. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'], outputFormats: ['jpg', 'png', 'webp'], keywords: ['rotate image online', 'image rotator', 'flip image online'], searchVolume: 8000 },
  'watermark-image': { slug: 'watermark-image', name: 'Watermark Image', description: 'Add text or image watermarks online free. Custom position, opacity, font. Browser-based.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['jpg', 'jpeg', 'png', 'webp'], outputFormats: ['jpg', 'png', 'webp'], keywords: ['watermark image online', 'add watermark to photo', 'watermark photo free'], searchVolume: 12000 },
  'image-workbench': { slug: 'image-workbench', name: 'Image Workbench', description: 'Full image editing pipeline: resize, crop, rotate, adjust brightness/contrast, add watermark, and convert format — all in one tool. Free, browser-based.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif'], outputFormats: ['jpg', 'png', 'webp'], keywords: ['image editor online free', 'image workbench', 'edit image online free'], searchVolume: 6000 },

  // ─── Image Utility / AI (7 tools) ────────────────────────────────────────

  'image-to-base64': { slug: 'image-to-base64', name: 'Image to Base64', description: 'Convert images to Base64 data URI online free. For CSS backgrounds, HTML embeds, JSON payloads. No signup.', category: 'utility', status: 'active', processingEngine: 'pure-js', inputFormats: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'], outputFormats: ['base64'], keywords: ['image to base64', 'base64 encode image', 'image to data uri'], searchVolume: 18000 },
  'base64-to-image': { slug: 'base64-to-image', name: 'Base64 to Image', description: 'Decode Base64 data URI back to image file online free. Download as PNG, JPG, or WEBP. No signup.', category: 'utility', status: 'active', processingEngine: 'pure-js', inputFormats: ['base64'], outputFormats: ['png', 'jpg', 'webp'], keywords: ['base64 to image', 'decode base64 image', 'base64 to png'], searchVolume: 12000 },
  'favicon-generator': { slug: 'favicon-generator', name: 'Favicon Generator', description: 'Generate favicons in all sizes from any image online free. ICO, PNG, Apple touch, Android icons. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: ['jpg', 'jpeg', 'png', 'webp', 'svg'], outputFormats: ['ico', 'png'], keywords: ['favicon generator', 'favicon maker', 'create favicon online free', 'ico generator'], searchVolume: 33000 },
  'background-remover': { slug: 'background-remover', name: 'Background Remover', description: 'Remove image background online free using AI. Transparent PNG output. No signup, images stay in your browser.', category: 'file-processing-heavy', status: 'active', processingEngine: 'onnx-wasm', inputFormats: ['jpg', 'jpeg', 'png', 'webp'], outputFormats: ['png'], keywords: ['background remover free', 'remove background from image', 'remove image background', 'bg remover'], searchVolume: 27000 },
  'image-to-text': { slug: 'image-to-text', name: 'Image to Text (OCR)', description: 'Extract text from images online free using AI OCR. Supports 100+ languages. No signup, browser-based.', category: 'file-processing-heavy', status: 'active', processingEngine: 'tesseract-wasm', inputFormats: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff'], outputFormats: ['txt'], keywords: ['image to text', 'ocr online free', 'extract text from image', 'image text extractor'], searchVolume: 22000 },
  'qr-code-generator': { slug: 'qr-code-generator', name: 'QR Code Generator', description: 'Generate custom QR codes free. Any URL or text. Custom colors, error correction, PNG/SVG download. No signup.', category: 'utility', status: 'active', processingEngine: 'pure-js', inputFormats: [], outputFormats: ['png', 'svg'], keywords: ['qr code generator free', 'qr code maker', 'generate qr code', 'free qr code'], searchVolume: 33000 },
  'profile-pic-creator': { slug: 'profile-pic-creator', name: 'Profile Pic Creator', description: 'Create custom emoji avatar profile pictures online free. Custom background, shape, size. No signup.', category: 'utility', status: 'active', processingEngine: 'canvas', inputFormats: [], outputFormats: ['png'], keywords: ['profile picture creator', 'avatar maker', 'profile photo maker free'], searchVolume: 4000 },

  // ─── Audio Tools (4 tools) ────────────────────────────────────────────────

  'audio-converter': { slug: 'audio-converter', name: 'Audio Converter', description: 'Convert audio files between MP3, WAV, AAC, FLAC, OGG, M4A, AIFF formats online free. Browser-based FFmpeg, no upload.', category: 'file-processing-heavy', status: 'active', processingEngine: 'ffmpeg-wasm', inputFormats: ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a', 'aiff', 'wma', 'opus', 'amr'], outputFormats: ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a', 'aiff'], keywords: ['audio converter online free', 'convert mp3 to wav', 'convert wav to mp3', 'audio format converter'], searchVolume: 110000 },
  'audio-recorder': { slug: 'audio-recorder', name: 'Audio Recorder', description: 'Record audio from your microphone online free. Download as MP3 or WEBM. No software install, no signup.', category: 'utility', status: 'active', processingEngine: 'native-api', inputFormats: [], outputFormats: ['webm', 'mp3'], keywords: ['online voice recorder', 'audio recorder online', 'record audio online free'], searchVolume: 70000 },
  'text-to-speech': { slug: 'text-to-speech', name: 'Text to Speech', description: 'Convert text to speech online free. Natural-sounding voices. Download as MP3. No signup, browser-based.', category: 'utility', status: 'active', processingEngine: 'native-api', inputFormats: ['text'], outputFormats: ['mp3', 'webm'], keywords: ['text to speech free online', 'tts online free', 'text to voice converter', 'read text aloud'], searchVolume: 200000 },
  'speech-to-text': { slug: 'speech-to-text', name: 'Speech to Text', description: 'Transcribe audio to text online free. Real-time voice recognition. No signup, works in your browser.', category: 'utility', status: 'active', processingEngine: 'native-api', inputFormats: ['audio', 'microphone'], outputFormats: ['txt'], keywords: ['speech to text online free', 'voice to text online', 'transcribe audio free', 'dictation online'], searchVolume: 150000 },

  // ─── Video Tools (3 tools) ────────────────────────────────────────────────

  'video-converter': { slug: 'video-converter', name: 'Video Converter', description: 'Convert video files between MP4, MOV, AVI, MKV, WEBM formats online free. Browser-based FFmpeg, files never uploaded.', category: 'file-processing-heavy', status: 'active', processingEngine: 'ffmpeg-wasm', inputFormats: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v'], outputFormats: ['mp4', 'mov', 'avi', 'mkv', 'webm'], keywords: ['video converter online free', 'convert mp4 online', 'mkv to mp4 online', 'video format converter'], searchVolume: 200000 },
  'video-recorder': { slug: 'video-recorder', name: 'Video Recorder', description: 'Record video from your webcam online free. Download as WEBM or MP4. No software install, no signup.', category: 'utility', status: 'active', processingEngine: 'native-api', inputFormats: [], outputFormats: ['webm', 'mp4'], keywords: ['online video recorder', 'webcam recorder online', 'record video online free'], searchVolume: 40000 },
  'screen-recorder': { slug: 'screen-recorder', name: 'Screen Recorder', description: 'Record your screen online free. No download required. HD quality, instant download. Works in Chrome and Edge.', category: 'utility', status: 'active', processingEngine: 'native-api', inputFormats: [], outputFormats: ['webm', 'mp4'], keywords: ['screen recorder online free', 'screen recorder no download', 'record screen online'], searchVolume: 80000 },
};

/**
 * Look up a tool by slug.
 * Returns undefined if the slug is not registered.
 */
export function getToolBySlug(slug: string): ToolDefinition | undefined {
  return TOOL_REGISTRY[slug];
}

/**
 * Check if a tool slug is registered and active.
 */
export function isToolActive(slug: string): boolean {
  const tool = TOOL_REGISTRY[slug];
  return !!tool && tool.status === 'active';
}
