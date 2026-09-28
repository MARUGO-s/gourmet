// Same IV(12) + tag(16) + ciphertext layout as the previous Node AES-256-GCM implementation.
async function key() {
  const secret = Deno.env.get("ENCRYPTION_KEY");
  if (!secret || secret.length < 32) throw new Error("Encryption not configured");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encrypt(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(value)));
  const bytes = new Uint8Array(12 + encrypted.length);
  bytes.set(iv); bytes.set(encrypted.slice(-16), 12); bytes.set(encrypted.slice(0,-16),28);
  return btoa(String.fromCharCode(...bytes));
}
export async function decrypt(value: string) {
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const encrypted = new Uint8Array(bytes.length-12);
  encrypted.set(bytes.slice(28)); encrypted.set(bytes.slice(12,28), bytes.length-28);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name:"AES-GCM", iv:bytes.slice(0,12) },await key(),encrypted));
}
