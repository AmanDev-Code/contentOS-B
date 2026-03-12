import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private supabase: SupabaseClient;
  private serviceRoleClient: SupabaseClient;

  constructor(private configService: ConfigService) {
    const supabaseUrl = this.configService.get<string>('supabase.url') || '';
    const supabaseAnonKey = this.configService.get<string>('supabase.anonKey') || '';
    const supabaseServiceKey = this.configService.get<string>(
      'supabase.serviceRoleKey',
    ) || '';

    this.supabase = createClient(supabaseUrl, supabaseAnonKey);
    this.serviceRoleClient = createClient(supabaseUrl, supabaseServiceKey);
  }

  getClient(): SupabaseClient {
    return this.supabase;
  }

  getServiceClient(): SupabaseClient {
    return this.serviceRoleClient;
  }
}
