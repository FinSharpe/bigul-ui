"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

type SessionValue = {
  clientCode: string | null;
  /** Shown inside the Bigul app's WebView, which owns sign-in and sign-out. */
  embedded: boolean;
};

const SessionContext = createContext<SessionValue>({
  clientCode: null,
  embedded: false,
});

/** The signed-in Bigul client, verified on the server by the page. */
export function SessionProvider({
  clientCode,
  embedded = false,
  children,
}: {
  clientCode: string;
  embedded?: boolean;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ clientCode, embedded }),
    [clientCode, embedded],
  );
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  return useContext(SessionContext);
}
