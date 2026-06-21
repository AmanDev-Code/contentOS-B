-- Rollback: remove agentic positioning blog drafts (by slug)
DELETE FROM blog_posts WHERE slug IN (
  'what-is-agentic-social-media-scheduling',
  'trndinn-vs-postiz-agentic-scheduler-vs-growth-os',
  'linkedin-autopilot-ai-agents-brand-voice',
  'blog-post-to-31-platforms-agentic-distribution-loop'
);
