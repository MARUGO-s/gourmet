import { createClient } from "@supabase/supabase-js";

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "https://ycsqfajidusuibqljjwr.supabase.co";
export const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_xAOS8yDSozbiGYnEwejKwQ_SZ4MYMmB";
export const supabase = createClient(supabaseUrl, publishableKey);
export const googleAuthEnabled = import.meta.env.VITE_GOOGLE_AUTH_ENABLED === "true";
export const authRedirect = () => new URL(import.meta.env.BASE_URL, window.location.origin).href;
