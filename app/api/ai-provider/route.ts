import { NextResponse } from "next/server";

import { AI_PROVIDERS, aiStatus, setAiProvider, type AiProvider } from "@/lib/ai-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

/** Which AI CLI answers (Codex or Gemini) and whether each one looks signed in. Never runs a model. */
export async function GET() {
  return NextResponse.json(await aiStatus(), { headers });
}

/** `{ provider: "codex" | "antigravity" | "gemini" | null }` — null clears the in-app choice so RIFT_LENS_AI_PROVIDER applies again. */
export async function POST(request: Request) {
  let body: { provider?: unknown };
  try { body = await request.json() as { provider?: unknown }; } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400, headers }); }
  const provider = body?.provider;
  if (provider !== null && !AI_PROVIDERS.includes(provider as AiProvider)) return NextResponse.json({ error: "Unknown AI provider." }, { status: 400, headers });
  await setAiProvider(provider as AiProvider | null);
  return NextResponse.json(await aiStatus(), { headers });
}
