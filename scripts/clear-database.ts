import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const DUMMY_UUID = '00000000-0000-0000-0000-000000000000';

async function deleteAll(table: string) {
  const { error, count } = await supabase
    .from(table)
    .delete()
    .neq('id', DUMMY_UUID);

  if (error) {
    console.error(`❌ Error deleting ${table}:`, error.message);
  } else {
    console.log(`✅ Cleared ${table} (${count ?? '?'} rows)`);
  }
}

async function clearDatabase() {
  console.log('🗑️  Starting full database cleanup...\n');

  try {
    // Order matters: child tables first (foreign keys)
    await deleteAll('scheduled_posts');
    await deleteAll('notification_reads');
    await deleteAll('notifications');
    await deleteAll('email_logs');
    await deleteAll('credit_transactions'); // references generated_content
    await deleteAll('generation_jobs');
    await deleteAll('generated_content');
    await deleteAll('generation_logs');

    console.log('\n✨ Database cleanup completed!');
  } catch (error) {
    console.error('❌ Unexpected error:', error);
    process.exit(1);
  }
}

clearDatabase();
