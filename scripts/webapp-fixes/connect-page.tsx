"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useSession, signIn } from "@/lib/auth-client";
import { Github, Loader2, Check, Copy, ExternalLink, ShieldCheck, ArrowLeft, Terminal } from "lucide-react";
import Link from "next/link";

function sanitizeCallbackUrl(raw: string | null): string {
  const fallback = "vscode://agenticmarket.andromity-agent/auth";
  if (!raw) return fallback;
  let decoded = raw.trim();
  try {
    while (decoded.includes("%3A") || decoded.includes("%2F") || decoded.includes("%3F")) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {}

  // Match any editor fork scheme (vscode, cursor, vscodium, windsurf, trae, code-oss, theia, etc.)
  if (/^[a-z0-9-+.]+:\/\/agenticmarket\.andromity-agent\/auth/i.test(decoded)) {
    return decoded;
  }
  return fallback;
}

function ConnectContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawCallback = searchParams.get("callback") || searchParams.get("callbackUrl");
  const callbackUrl = sanitizeCallbackUrl(rawCallback);

  const { data: session, isPending } = useSession();
  const [tokenData, setTokenData] = useState<{
    token: string;
    username: string;
    email: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [socialLoading, setSocialLoading] = useState<"github" | "google" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string>("");

  useEffect(() => {
    if (!session?.user) return;

    let isMounted = true;
    async function acquireToken() {
      try {
        const res = await fetch("/api/andromity/token", {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Unable to complete sign-in. Please retry.");
        if (!isMounted) return;

        setTokenData(data);
        const sep = callbackUrl.includes("?") ? "&" : "?";
        const finalUrl = `${callbackUrl}${sep}token=${encodeURIComponent(data.token)}&username=${encodeURIComponent(data.username)}&email=${encodeURIComponent(data.email || "")}`;
        setRedirectUrl(finalUrl);
        if (typeof window !== "undefined") {
          setTimeout(() => { window.location.href = finalUrl; }, 350);
        }
      } catch (err: any) {
        if (isMounted) setError(err.message || "Failed to issue token");
      }
    }

    acquireToken();
    return () => {
      isMounted = false;
    };
  }, [session, callbackUrl]);

  const handleSocial = async (provider: "github" | "google") => {
    setError(null);
    setSocialLoading(provider);
    try {
      await signIn.social({
        provider,
        callbackURL: typeof window !== "undefined" ? window.location.href : "/auth/connect",
      });
    } catch (err: any) {
      setError(err.message || "Authentication failed");
    } finally {
      setSocialLoading(null);
    }
  };

  const copyToken = () => {
    if (tokenData?.token && typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(tokenData.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (isPending) {
    return (
      <div className="min-h-screen bg-background text-white flex items-center justify-center font-sans">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-[#00FF94]" />
          <p className="text-sm font-mono text-[#888888]">Checking authentication...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-white flex flex-col font-sans relative">
      <main className="w-full max-w-[600px] mx-auto px-4 py-16 flex-1 flex flex-col justify-center">
        <div className="bg-[#111111] border border-[#222222] rounded-lg p-6 sm:p-8 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-[#00FF94] to-transparent" />

          <div className="mb-6 flex items-center justify-between">
            <Link
              href="/dashboard"
              className="inline-flex items-center text-xs text-[#888888] hover:text-white transition-colors font-mono"
            >
              <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Dashboard
            </Link>
            <span className="text-[11px] font-mono uppercase tracking-wider text-[#00FF94] bg-[#00FF94]/10 border border-[#00FF94]/20 px-2 py-0.5 rounded-full">
              VS Code Connector
            </span>
          </div>

          <div className="text-center mb-8">
            <h1 className="text-xl sm:text-2xl font-semibold text-white tracking-tight mb-2">
              Connect to Andromity
            </h1>
            <p className="text-sm text-[#888888]">
              Unlock authenticated cloud intelligence and fallback routing directly in your IDE.
            </p>
          </div>

          {error && (
            <div className="mb-6 p-3 rounded bg-rose-500/10 border border-rose-500/30 text-xs text-rose-400">
              {error}
            </div>
          )}

          {!session?.user ? (
            <div className="space-y-4">
              <button
                type="button"
                disabled={socialLoading !== null}
                onClick={() => handleSocial("github")}
                className="w-full flex items-center justify-center gap-3 bg-[#0A0A0A] hover:bg-[#161616] border border-[#262626] text-white py-3 rounded text-sm font-medium transition-all"
              >
                {socialLoading === "github" ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[#00FF94]" />
                ) : (
                  <Github className="h-4 w-4" />
                )}
                Continue with GitHub
              </button>

              <button
                type="button"
                disabled={socialLoading !== null}
                onClick={() => handleSocial("google")}
                className="w-full flex items-center justify-center gap-3 bg-[#0A0A0A] hover:bg-[#161616] border border-[#262626] text-white py-3 rounded text-sm font-medium transition-all"
              >
                {socialLoading === "google" ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[#00FF94]" />
                ) : (
                  <svg className="h-4 w-4" viewBox="0 0 24 24">
                    <path
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      fill="#4285F4"
                    />
                    <path
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      fill="#34A853"
                    />
                    <path
                      d="M2.18 14.77c-.26-.78-.4-1.61-.4-2.47s.14-1.69.4-2.47V6.99H7.7C6.86 8.53 6.36 10.21 6.36 12s.5 3.47 1.34 5.01L2.18 14.77z"
                      fill="#FBBC05"
                    />
                    <path
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 6.99l5.52 4.29c.87-2.6 3.3-4.53 6.3-4.53z"
                      fill="#EA4335"
                    />
                  </svg>
                )}
                Continue with Google
              </button>

              <div className="pt-4 border-t border-[#1F1F1F] text-center">
                <Link
                  href={`/login?next=${encodeURIComponent(typeof window !== "undefined" ? window.location.pathname + window.location.search : "/auth/connect")}`}
                  className="text-xs text-[#888888] hover:text-white transition-colors"
                >
                  Already have an account? Sign in with email
                </Link>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="bg-[#0A0A0A] border border-[#222222] p-4 rounded flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-[#161616] border border-[#333333] flex items-center justify-center font-mono font-bold text-xs text-[#00FF94]">
                    {(session.user.name || session.user.email || "U").slice(0, 2).toUpperCase()}
                  </div>
                  <div className="text-left">
                    <div className="text-sm font-medium text-white flex items-center gap-2">
                      <span>{session.user.name || "Authenticated Developer"}</span>
                      <ShieldCheck className="w-3.5 h-3.5 text-[#00FF94]" />
                    </div>
                    <div className="text-xs text-[#666666] font-mono">{session.user.email}</div>
                  </div>
                </div>
                <span className="text-[11px] font-mono text-[#00FF94] bg-[#00FF94]/10 border border-[#00FF94]/20 px-2 py-0.5 rounded">
                  Community Account
                </span>
              </div>

              {redirectUrl ? (
                <div className="space-y-3">
                  <a
                    href={redirectUrl}
                    className="w-full flex items-center justify-center gap-2 bg-[#00FF94] hover:bg-[#00FF94]/90 text-black py-3 rounded text-sm font-semibold transition-all shadow-[0_0_20px_rgba(0,255,148,0.2)]"
                  >
                    <ExternalLink className="w-4 h-4" /> Open VS Code
                  </a>
                  <p className="text-[11px] text-center text-[#888888] font-mono">
                    Click the button above to link your session with Visual Studio Code.
                  </p>
                </div>
              ) : (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-5 h-5 animate-spin text-[#00FF94]" />
                </div>
              )}

              {tokenData?.token && (
                <div className="pt-4 border-t border-[#1F1F1F] space-y-2">
                  <div className="flex items-center justify-between text-xs text-[#888888] font-mono">
                    <span>Manual Token Backup</span>
                    <button
                      type="button"
                      onClick={copyToken}
                      className="inline-flex items-center gap-1 text-[#00FF94] hover:underline"
                    >
                      {copied ? (
                        <>
                          <Check className="w-3.5 h-3.5" /> Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" /> Copy Token
                        </>
                      )}
                    </button>
                  </div>
                  <div className="bg-[#050505] border border-[#1A1A1A] p-2.5 rounded font-mono text-xs text-[#CCCCCC] truncate select-all">
                    {tokenData.token}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default function ConnectPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background text-white flex items-center justify-center font-sans">
          <Loader2 className="w-6 h-6 animate-spin text-[#00FF94]" />
        </div>
      }
    >
      <ConnectContent />
    </Suspense>
  );
}
