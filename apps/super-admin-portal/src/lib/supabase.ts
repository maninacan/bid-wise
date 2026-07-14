import { createClient, type User } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

export const supabase = createClient(supabaseUrl, supabaseKey);

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.session) throw new Error('Sign in failed.');
  return data.session;
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/** True if the signed-in user's app_metadata carries the SuperAdmin role (set via the Supabase admin API — not self-grantable). */
export function isSuperAdmin(user: User | null | undefined): boolean {
  const roles = (user?.app_metadata?.roles ?? []) as string[];
  return roles.includes('SuperAdmin');
}

/** Authorization header carrying the current Supabase access token, for GraphQL calls. */
export async function authContext(): Promise<{ headers: Record<string, string> }> {
  const { data: { session } } = await supabase.auth.getSession();
  return { headers: { Authorization: `Bearer ${session?.access_token ?? supabaseKey}` } };
}
