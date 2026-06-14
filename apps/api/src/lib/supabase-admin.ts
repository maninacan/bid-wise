// Shared service-role Supabase client for the api app. The service role bypasses
// RLS, so every handler must authorize the request itself (verify the JWT, then
// scope queries by user_id / linked subcontractor as appropriate).
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  // Surface misconfiguration loudly at startup rather than per-request.
  console.warn('[supabase-admin] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.');
}

export const supabaseAdmin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

/** Resolves the user for a raw `Authorization: Bearer <jwt>` header value (or empty string). */
export async function getUserFromAuthHeader(authHeader: string): Promise<User | null> {
  const jwt = (authHeader ?? '').replace('Bearer ', '');
  if (!jwt) return null;
  const { data: { user } } = await supabaseAdmin.auth.getUser(jwt);
  return user ?? null;
}
