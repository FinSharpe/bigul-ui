import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Thread } from "@langchain/langgraph-sdk";
import { parseAsBoolean, useQueryState } from "nuqs";
import {
  History,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { BrandMark } from "@/components/brand-mark";
import { useSession } from "@/providers/Session";
import { useThreads } from "@/providers/Thread";
import { SignOutButton } from "../sign-out-button";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import {
  filterThreadHistory,
  getThreadHistoryGroup,
  getThreadTitle,
  THREAD_HISTORY_BATCH_SIZE,
  THREAD_HISTORY_GROUPS,
} from "@/lib/thread-history";
import { cn } from "@/lib/utils";

type Density = "compact" | "touch";

function ThreadList({
  threads,
  query,
  currentId,
  onSelect,
  density,
}: {
  threads: Thread[];
  query: string;
  currentId: string | null;
  onSelect: (threadId: string) => void;
  /** `compact`: the desktop sidebar's rows. `touch`: the phone drawer's. */
  density: Density;
}) {
  const [shown, setShown] = useState(THREAD_HISTORY_BATCH_SIZE);
  if (threads.length === 0) {
    return <HistoryNote>Your conversations will appear here.</HistoryNote>;
  }

  const filtered = filterThreadHistory(threads, query);
  if (filtered.length === 0) {
    return <HistoryNote>No chats match your search.</HistoryNote>;
  }
  const hasMore = !query.trim() && filtered.length > shown;
  const visible = hasMore ? filtered.slice(0, shown) : filtered;
  const now = new Date();
  const compact = density === "compact";

  return (
    <div className={cn("pb-3", compact ? "px-2" : "space-y-3 px-4")}>
      {THREAD_HISTORY_GROUPS.map((group) => {
        const rows = visible.filter(
          (thread) => getThreadHistoryGroup(thread.updated_at, now) === group,
        );
        if (!rows.length) return null;
        return (
          <section
            key={group}
            aria-label={group}
            className={cn(compact && "mb-2")}
          >
            <h3
              className={cn(
                "text-muted-foreground font-medium",
                compact
                  ? "px-2.5 pt-1.5 pb-1 text-[11px]"
                  : "px-2 py-1 text-xs tracking-wider uppercase",
              )}
            >
              {group}
            </h3>
            <ul className="space-y-0.5">
              {rows.map((thread) => {
                const title = getThreadTitle(thread);
                const current = thread.thread_id === currentId;
                return (
                  <li key={thread.thread_id}>
                    <button
                      type="button"
                      aria-current={current ? "page" : undefined}
                      title={title}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 rounded-[10px] text-left transition-colors",
                        compact
                          ? "h-9 px-2.5 text-[13.5px]"
                          : "min-h-11 px-3 py-2 text-sm font-medium",
                        current
                          ? "bg-secondary text-primary"
                          : "hover-tint text-foreground",
                      )}
                      onClick={() => onSelect(thread.thread_id)}
                    >
                      <span className="min-w-0 flex-1 truncate">{title}</span>
                      {thread.status === "busy" && (
                        <span
                          role="status"
                          className="bg-primary size-1.5 shrink-0 rounded-full motion-safe:animate-pulse"
                        >
                          <span className="sr-only">Answer in progress</span>
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            type="button"
            variant="secondary"
            className="h-9 rounded-full px-4 text-xs font-medium"
            onClick={() =>
              setShown((count) => count + THREAD_HISTORY_BATCH_SIZE)
            }
          >
            Show more
          </Button>
        </div>
      )}
    </div>
  );
}

function HistoryNote({ children }: { children: ReactNode }) {
  return (
    <p
      className="text-muted-foreground px-5 py-6 text-center text-[13px] leading-[1.45]"
      role="status"
    >
      {children}
    </p>
  );
}

function ThreadHistoryLoading({ density }: { density: Density }) {
  return (
    <div
      className={cn("space-y-1", density === "compact" ? "px-2" : "px-4")}
      role="status"
      aria-label="Loading conversations"
    >
      <span className="sr-only">Loading conversations…</span>
      <div className="px-2.5 pt-2.5 pb-2">
        <Skeleton className="h-2.5 w-12" />
      </div>
      {["78%", "62%", "85%", "54%", "70%", "66%"].map((width, index) => (
        <div
          key={index}
          className={cn(
            "flex items-center px-2.5",
            density === "compact" ? "h-9" : "h-11",
          )}
        >
          <Skeleton
            className="h-3"
            style={{ width }}
          />
        </div>
      ))}
    </div>
  );
}

function Avatar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-secondary text-primary flex size-9 shrink-0 items-center justify-center rounded-full",
        className,
      )}
    >
      <UserRound className="size-4" />
    </span>
  );
}

// Whether the desktop sidebar is folded to its icon rail. Read through
// useSyncExternalStore, so the server and the first client render agree and
// the stored choice applies right after.
const COLLAPSED_KEY = "bigul:sidebar-collapsed";
const collapsedListeners = new Set<() => void>();
let collapsedFallback = false;

function readCollapsed(): boolean {
  try {
    const stored = window.localStorage.getItem(COLLAPSED_KEY);
    return stored === null ? collapsedFallback : stored === "true";
  } catch {
    return collapsedFallback;
  }
}

function writeCollapsed(value: boolean) {
  collapsedFallback = value;
  try {
    window.localStorage.setItem(COLLAPSED_KEY, String(value));
  } catch {
    // Private mode: the in-memory value still applies for this visit.
  }
  collapsedListeners.forEach((listener) => listener());
}

function subscribeCollapsed(listener: () => void) {
  collapsedListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    collapsedListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function useSidebarCollapsed() {
  return useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
}

export default function ThreadHistory({
  onNewChat,
  onThreadSelect,
}: {
  onNewChat?: () => void;
  onThreadSelect?: (threadId: string) => void;
}) {
  const isLargeScreen = useMediaQuery("(min-width: 1024px)");
  const [threadId, setThreadId] = useQueryState("threadId");
  const [chatHistoryOpen, setChatHistoryOpen] = useQueryState(
    "chatHistoryOpen",
    parseAsBoolean.withDefault(false),
  );
  const collapsed = useSidebarCollapsed();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const { refreshThreads, threads, threadsLoading, threadsError } =
    useThreads();
  const { clientCode } = useSession();

  // Desktop shows the list whenever the sidebar is expanded; phones only
  // while the drawer is open. Re-read the list each time it comes into view.
  const listVisible = isLargeScreen ? !collapsed : chatHistoryOpen;
  useEffect(() => {
    if (listVisible) void refreshThreads();
  }, [listVisible, refreshThreads]);

  const closeHistory = () => {
    setQuery("");
    void setChatHistoryOpen(false);
  };

  const startNewChat = () => {
    if (onNewChat) onNewChat();
    else void setThreadId(null);
    if (!isLargeScreen) closeHistory();
  };

  const selectThread = (id: string) => {
    if (id !== threadId) {
      if (onThreadSelect) onThreadSelect(id);
      else void setThreadId(id);
    }
    if (!isLargeScreen) closeHistory();
  };

  const expandToSearch = () => {
    writeCollapsed(false);
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  const list = (density: Density) => (
    <>
      <div
        className="h-0.5 shrink-0 overflow-hidden"
        aria-hidden="true"
      >
        {threadsLoading && threads.length > 0 && (
          <div className="bg-primary/40 h-full w-full motion-safe:animate-pulse" />
        )}
      </div>
      <div className="min-h-0 flex-1 [scrollbar-width:none] overflow-y-auto overscroll-contain">
        {threadsError && threads.length > 0 && (
          <div
            className="text-muted-foreground flex items-center gap-2 px-5 py-2 text-xs"
            role="status"
          >
            <span className="flex-1">Could not refresh your chats.</span>
            <Button
              variant="link"
              className="h-8 px-0 text-xs"
              disabled={threadsLoading}
              onClick={() => void refreshThreads()}
            >
              Retry
            </Button>
          </div>
        )}
        {threadsLoading && threads.length === 0 ? (
          <ThreadHistoryLoading density={density} />
        ) : threadsError && threads.length === 0 ? (
          <div
            className="p-5 text-xs leading-[1.45]"
            role="alert"
          >
            <p className="text-muted-foreground">Could not load your chats.</p>
            <Button
              variant="link"
              className="mt-1 h-9 px-0 text-xs"
              onClick={() => void refreshThreads()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <ThreadList
            key={String(listVisible)}
            threads={threads}
            query={query}
            currentId={threadId}
            onSelect={selectThread}
            density={density}
          />
        )}
      </div>
      {threadsLoading && threads.length > 0 && (
        <span
          className="sr-only"
          role="status"
        >
          Refreshing conversations…
        </span>
      )}
    </>
  );

  // Desktop rail, folded: expand, new chat, search, then the account.
  const rail = (
    <div className="flex h-full w-[70px] flex-col items-center">
      <div className="flex h-[52px] w-full shrink-0 items-center justify-center">
        <button
          type="button"
          onClick={() => writeCollapsed(false)}
          title="Expand sidebar"
          aria-label="Expand sidebar"
          className="hover-tint text-muted-foreground hover:text-primary flex size-10 cursor-pointer items-center justify-center rounded-[10px] transition-colors"
        >
          <PanelLeftOpen className="size-5" />
        </button>
      </div>
      <nav
        className="w-full shrink-0 space-y-0.5 px-2"
        aria-label="Chats"
      >
        <button
          type="button"
          onClick={startNewChat}
          title="New chat"
          aria-label="New chat"
          className="bg-mint text-mint-foreground mb-1.5 flex h-10 w-full cursor-pointer items-center justify-center rounded-[10px] transition-colors hover:brightness-[0.97]"
        >
          <Plus
            className="size-5"
            strokeWidth={2.25}
          />
        </button>
        <button
          type="button"
          onClick={expandToSearch}
          title="Search chats"
          aria-label="Search chats"
          className="hover-tint text-foreground flex h-10 w-full cursor-pointer items-center justify-center rounded-[10px] transition-colors"
        >
          <Search className="size-5" />
        </button>
      </nav>
      <div className="flex-1" />
      {clientCode && (
        <div className="flex w-full shrink-0 flex-col items-center gap-1 px-2 pb-2">
          <span
            title={`Signed in as ${clientCode}`}
            className="flex h-12 items-center justify-center"
          >
            <Avatar />
            <span className="sr-only">Signed in as {clientCode}</span>
          </span>
          <SignOutButton variant="row" />
        </div>
      )}
    </div>
  );

  // Desktop sidebar, expanded: logo, one primary action, search, then the
  // chats and the account row. Quiet rows, so the chat carries the weight.
  const sidebar = (
    <div className="flex h-full w-[262px] flex-col">
      <div className="flex h-[52px] shrink-0 items-center justify-between pr-3 pl-4">
        <BrandMark className="h-6" />
        <button
          type="button"
          onClick={() => writeCollapsed(true)}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
          className="hover-tint text-muted-foreground hover:text-primary flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors"
        >
          <PanelLeftClose className="size-5" />
        </button>
      </div>
      <nav
        className="shrink-0 space-y-0.5 px-2"
        aria-label="Chats"
      >
        <button
          type="button"
          onClick={startNewChat}
          className="bg-mint text-mint-foreground mb-1.5 flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[13.5px] font-medium transition-colors hover:brightness-[0.97]"
        >
          <Plus
            className="size-5"
            strokeWidth={2.25}
          />
          New chat
        </button>
        <label className="hover-tint focus-within:bg-secondary flex h-10 w-full cursor-text items-center gap-2.5 rounded-[10px] px-2.5 transition-colors">
          <Search
            className="text-foreground size-5 shrink-0"
            aria-hidden="true"
          />
          <input
            ref={searchRef}
            aria-label="Search chats"
            type="search"
            placeholder="Search chats"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setQuery("")}
            className="placeholder:text-foreground/60 min-w-0 flex-1 bg-transparent text-[13.5px] outline-none"
          />
        </label>
      </nav>
      <div className="mt-4 flex h-7 shrink-0 items-center pr-3 pl-4">
        <span className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">
          Chats
        </span>
      </div>
      {list("compact")}
      {clientCode && (
        <div className="shrink-0 p-2">
          <div className="flex h-12 items-center gap-2.5 rounded-[10px] px-2.5">
            <Avatar />
            <p className="min-w-0 flex-1 leading-tight">
              <span className="text-muted-foreground block text-[11px]">
                Signed in as
              </span>
              <span className="block truncate text-[13.5px] font-medium">
                {clientCode}
              </span>
            </p>
            <SignOutButton variant="row" />
          </div>
        </div>
      )}
    </div>
  );

  // Phone drawer: the reference's history panel.
  const drawer = (
    <>
      <div className="border-border/60 flex min-h-14 shrink-0 items-center gap-2.5 border-b py-3 pr-14 pl-4">
        <History
          className="text-primary size-[17px]"
          strokeWidth={1.6}
          aria-hidden="true"
        />
        <SheetTitle className="text-base leading-[1.35] font-medium tracking-tight">
          Conversations
        </SheetTitle>
      </div>
      <div className="shrink-0 space-y-2 px-4 pt-3 pb-2">
        <button
          type="button"
          onClick={startNewChat}
          className="brand-gradient flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-full px-4 py-3 text-sm font-medium text-white shadow-md shadow-[#0a1f4d]/10 transition-all hover:brightness-110 active:scale-[0.98]"
        >
          <Plus
            className="size-3.5"
            strokeWidth={2.5}
          />
          New chat
        </button>
        <div className="bg-muted border-border focus-within:border-primary/50 flex h-11 items-center rounded-full border px-3">
          <Search
            className="text-foreground mr-2 size-3.5 shrink-0"
            aria-hidden="true"
          />
          <input
            aria-label="Search chats"
            type="search"
            placeholder="Search chats…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="placeholder:text-foreground/50 min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </div>
      </div>
      {list("touch")}
      {clientCode && (
        <div className="border-border/60 bg-muted flex shrink-0 items-center gap-2.5 border-t py-3 pr-2 pl-4">
          <Avatar className="size-8" />
          <p className="min-w-0 flex-1 leading-tight">
            <span className="text-muted-foreground block text-[11px]">
              Signed in as
            </span>
            <span className="block truncate text-sm font-medium">
              {clientCode}
            </span>
          </p>
          <SignOutButton variant="row" />
        </div>
      )}
    </>
  );

  return (
    <>
      {/* Drawn by CSS at ≥1024px, so the first paint already has it. */}
      <aside
        aria-label="Conversation history"
        className={cn(
          "bg-background border-border hidden h-dvh shrink-0 overflow-hidden border-r transition-[width] duration-200 motion-reduce:transition-none lg:flex",
          collapsed ? "w-[70px]" : "w-[262px]",
        )}
      >
        {collapsed ? rail : sidebar}
      </aside>
      {!isLargeScreen && (
        <Sheet
          open={chatHistoryOpen}
          onOpenChange={(open) => {
            if (open) void setChatHistoryOpen(true);
            else closeHistory();
          }}
        >
          <SheetContent
            side="left"
            aria-describedby={undefined}
            className="w-[min(82vw,290px)] gap-0 sm:max-w-[290px] [&>button:last-child]:top-3 [&>button:last-child]:right-3 [&>button:last-child]:flex [&>button:last-child]:size-8 [&>button:last-child]:items-center [&>button:last-child]:justify-center [&>button:last-child]:rounded-full"
          >
            {drawer}
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
