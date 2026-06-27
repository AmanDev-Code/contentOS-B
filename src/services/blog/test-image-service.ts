"use strict";

import { BlogImageService } from './image-service';

// Manual test harness for image service
async function testImageService() {
  // Create a mock service instance (inject real dependencies in actual testing)
  const service = new BlogImageService(null as any, null as any, null as any);
  
  console.log("=== Image Service Test Harness ===\n");
  
  // Test case from requirements
  const testPost = {
    title: "How Trndinn's Brand Kit Ensures LinkedIn Posts Sound Like You",
    slug: "brand-kit-linkedin-consistency",
    keywords: ["brand voice", "LinkedIn", "AI posts"],
    id: "test-123"
  };
  
  console.log("Test Post:", testPost);
  
  // Test prompt building
  const prompt = service['buildPrompt'](testPost.title, testPost.keywords);
  console.log("\n1. Generated Prompt:");
  console.log(prompt);
  
  // Test prompt sanitization
  const sanitizedPrompt = service['sanitizePrompt'](prompt);
  console.log("\n2. Sanitized Prompt:");
  console.log(sanitizedPrompt);
  
  // Test file name generation
  const fileName = service['generateFileName'](testPost.title, testPost.keywords?.[0]);
  console.log("\n3. Generated File Name:");
  console.log(fileName);
  console.log("Validation:", fileName === "brand-voice-how-trndinns-brand-kit-ensures-20260627.webp" ? "✅ PASS" : "❌ FAIL");
  
  // Test alt text generation
  const altText = service['generateAltText'](testPost.title, testPost.keywords);
  console.log("\n4. Generated Alt Text:");
  console.log(altText);
  console.log("Validation:", altText.length <= 125 ? "✅ PASS" : "❌ FAIL");
  console.log("Contains primary keyword:", altText.toLowerCase().includes("brand voice") ? "✅ PASS" : "❌ FAIL");
  
  // Test platform-specific alt text
  const linkedInAlt = service.generatePlatformAltText(testPost.title, "linkedin", testPost.keywords);
  console.log("\n5. LinkedIn Alt Text:");
  console.log(linkedInAlt);
  
  console.log("\n=== Test Complete ===");
}

// Run the test
testImageService().catch(console.error);