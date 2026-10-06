import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "../../../../../db";
import { user } from "../../../../../db/schema";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let username = session.user.name || session.user.id;
    try {
      const [userRow] = await db
        .select({ username: user.username })
        .from(user)
        .where(eq(user.id, session.user.id));
      if (userRow?.username) username = userRow.username;
    } catch {}

    const token = `andromity_${randomBytes(32).toString("hex")}`;
    const gatewayUrl = (process.env.ANDROMITY_GATEWAY_URL || "https://gateway.agenticmarket.dev").replace(/\/+$/, "");
    const register = (sessionToken: string) => fetch(`${gatewayUrl}/v1/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: sessionToken, userId: username, username, email: session.user.email || "" }),
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });

    try {
      const registered = await register(token);
      if (!registered.ok) {
        return NextResponse.json({ error: "Account session could not be activated. Please retry sign-in shortly." }, { status: 503 });
      }
      // Preserve the dashboard's existing usage token; its failure must not
      // discard a successfully registered IDE session.
      await register(`andromity_${username}`).catch(() => undefined);
    } catch {
      return NextResponse.json({ error: "The Andromity gateway is unavailable. Please retry sign-in shortly." }, { status: 503 });
    }

    return NextResponse.json({ token, userId: username, username, email: session.user.email || "", plan: "authenticated" },
      { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Unable to complete sign-in. Please retry." }, { status: 500 });
  }
}
