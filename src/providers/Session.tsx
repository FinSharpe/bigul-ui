"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

type SessionValue = { clientCode: string | null };

const SessionContext = createContext<SessionValue>({ clientCode: null });

/** The signed-in Bigul client, verified on the server by the page. */
export function SessionProvider({
  clientCode,
  children,
}: {
  clientCode: string;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ clientCode }), [clientCode]);
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  return useContext(SessionContext);
}
