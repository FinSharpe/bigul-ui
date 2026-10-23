import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { Input } from "@/components/ui/input";
import { isDevLoginEnabled } from "@/lib/auth/config";
import { safeNextPath } from "@/lib/auth/next-path";
import { getServerSession } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Sign in",
};

const ERROR_MESSAGES: Record<string, string> = {
  denied: "Sign-in was cancelled or didn't finish. Please try again.",
  state:
    "Your sign-in timed out or was started in another tab. Please try again.",
  verify: "We couldn't confirm your Bigul account. Please sign in again.",
  unavailable:
    "We couldn't reach Bigul just now. Please try again in a few minutes.",
  config: "Sign-in isn't available right now. Please try again later.",
};

type SearchParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const next = safeNextPath(first(params.next));
  if (await getServerSession()) redirect(next);

  const error = first(params.error);
  const message =
    error && Object.hasOwn(ERROR_MESSAGES, error)
      ? ERROR_MESSAGES[error]
      : undefined;

  return (
    <main className="bg-muted flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="bg-background w-full max-w-sm rounded-xl border p-8 text-center shadow-[var(--chat-card-shadow)]">
        <BrandMark className="mx-auto h-14" />
        <h1 className="sr-only">Mayra AI</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Sign in with your Bigul account to continue.
        </p>
        {message && (
          <div
            role="alert"
            className="border-destructive/20 text-destructive mt-5 flex items-start gap-2 rounded-xl border bg-[var(--negative-container)] px-3 py-2.5 text-left text-sm"
          >
            <AlertCircle
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <span>{message}</span>
          </div>
        )}
        {/* A plain link: /auth/login is a redirect, not a page to prefetch. */}
        <a
          href={`/auth/login?next=${encodeURIComponent(next)}`}
          className="focus-visible:ring-ring/50 mt-6 inline-flex h-11 w-full items-center justify-center rounded-full text-sm font-medium text-white outline-none [background:var(--brand-gradient)] hover:opacity-90 focus-visible:ring-[3px]"
        >
          Sign in with Bigul
        </a>
        {isDevLoginEnabled() && (
          <form
            method="get"
            action="/auth/dev-login"
            className="mt-6 border-t pt-5 text-left"
          >
            <p className="text-muted-foreground text-xs font-semibold tracking-[0.7px] uppercase">
              Development sign-in
            </p>
            <input
              type="hidden"
              name="next"
              value={next}
            />
            <label
              htmlFor="dev-client-code"
              className="mt-3 block text-sm font-medium"
            >
              Client code
            </label>
            <div className="mt-1.5 flex gap-2">
              <Input
                id="dev-client-code"
                name="client"
                defaultValue="TEST01"
                maxLength={32}
                autoComplete="off"
                required
                className="h-10 rounded-full px-4"
              />
              <button
                type="submit"
                className="hover:bg-accent h-10 shrink-0 rounded-full border px-4 text-sm font-medium"
              >
                Sign in
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
