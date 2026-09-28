import { createClient } from "npm:@supabase/supabase-js@2.116.0";
export const service = () => createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth:{persistSession:false,autoRefreshToken:false} });
const origins = new Set(["https://marugo-s.github.io", "http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173"]);
export function cors(req: Request) {
  const origin=req.headers.get("origin") ?? "";
  return { "Access-Control-Allow-Origin":origins.has(origin)?origin:"https://marugo-s.github.io", "Vary":"Origin", "Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info", "Access-Control-Allow-Methods":"GET,POST,DELETE,OPTIONS" };
}
export function json(req: Request, value: unknown, status=200) { return new Response(JSON.stringify(value),{status,headers:{...cors(req),"Content-Type":"application/json","Cache-Control":"no-store"}}); }
export async function body(req: Request) {
  const text=await req.text();
  if(text.length>2_000_000) throw new Error("Request too large");
  return JSON.parse(text);
}
export const publicJob = (j: any) => ({id:j.id,sources:j.sources,status:j.status,step:j.step,message:j.message,startedAt:j.started_at,finishedAt:j.finished_at,results:j.results,dispatchStatus:j.dispatch_status??null});
