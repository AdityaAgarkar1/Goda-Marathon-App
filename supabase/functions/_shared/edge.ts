// supabase/functions/_shared/edge.ts
//
// Plumbing every edge function in this project needs: CORS, JSON responses,
// required secrets, the service-role client and a constant-time comparison for
// signatures. Folders that start with an underscore are not deployed as
// functions of their own; each function bundles what it imports from here.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown for a missing secret, so each function can answer 503 consistently. */
export class ConfigError extends Error {}

export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new ConfigError(`${name} is not set`);
  return value;
}

/** Service-role client. Bypasses RLS, so it never leaves the edge function. */
export function serviceClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Constant-time, so the comparison cannot be timed to guess a signature byte by byte. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
