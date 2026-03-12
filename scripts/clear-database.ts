import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function clearDatabase() {
  console.log('🗑️  Starting database cleanup...\n');

  try {
    // 1. Delete all generation_jobs (must be first due to foreign key)
    console.log('Deleting generation_jobs...');
    const { error: jobsError, count: jobsCount } = await supabase
      .from('generation_jobs')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all

    if (jobsError) {
      console.error('❌ Error deleting generation_jobs:', jobsError);
    } else {
      console.log(`✅ Deleted ${jobsCount || 0} generation_jobs\n`);
    }

    // 2. Delete all generated_content
    console.log('Deleting generated_content...');
    const { error: contentError, count: contentCount } = await supabase
      .from('generated_content')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all

    if (contentError) {
      console.error('❌ Error deleting generated_content:', contentError);
    } else {
      console.log(`✅ Deleted ${contentCount || 0} generated_content\n`);
    }

    // 3. Delete all generation_logs (optional)
    console.log('Deleting generation_logs...');
    const { error: logsError, count: logsCount } = await supabase
      .from('generation_logs')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all

    if (logsError) {
      console.error('❌ Error deleting generation_logs:', logsError);
    } else {
      console.log(`✅ Deleted ${logsCount || 0} generation_logs\n`);
    }

    console.log('✨ Database cleanup completed successfully!');
  } catch (error) {
    console.error('❌ Unexpected error:', error);
    process.exit(1);
  }
}

// Run the cleanup
clearDatabase();
