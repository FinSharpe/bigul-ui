import { fetch as relayFetch, Pool, ProxyAgent, type Dispatcher } from "undici";

// Server-only. Sends the Bigul partner API calls, and nothing else, through
// fixed-IP relays (BIGUL_OUTBOUND_PROXY_URLS). Each call is a CONNECT tunnel,
// so TLS runs end to end between this app and Bigul. Uses undici's own fetch
// with a per-relay dispatcher; the global fetch and dispatcher are untouched.

/** Time to reach a relay and have it open the tunnel (TCP + CONNECT reply). */
export const RELAY_CONNECT_TIMEOUT_MS = 3_000;

/** The tunnel was not opened, so the request never reached Bigul. */
class RelayConnectError extends Error {
  /** The relay's CONNECT reply status when it refused the tunnel. */
  readonly status: number | undefined;

  constructor(status: number | undefined, cause?: unknown) {
    super("Relay tunnel not opened", cause === undefined ? {} : { cause });
    this.name = "RelayConnectError";
    this.status = status;
  }
}

type Tunnel = (
  options: Dispatcher.ConnectOptions,
) => Promise<Dispatcher.ConnectData>;

/**
 * The client ProxyAgent uses to talk to the relay itself. Anything that goes
 * wrong while opening a tunnel is reported as a RelayConnectError, which is
 * the only failure that moves a call on to the next relay.
 */
function relayClient(origin: URL, options: object): Dispatcher {
  const pool = new Pool(origin, options);
  const open: Tunnel = pool.connect.bind(pool);
  const tunnel: Tunnel = async (connectOptions) => {
    const timeout = AbortSignal.timeout(RELAY_CONNECT_TIMEOUT_MS);
    const given = connectOptions.signal;
    let data: Dispatcher.ConnectData;
    try {
      data = await open({
        ...connectOptions,
        signal:
          given instanceof AbortSignal
            ? AbortSignal.any([given, timeout])
            : timeout,
      });
    } catch (error) {
      throw new RelayConnectError(undefined, error);
    }
    if (data.statusCode !== 200) {
      data.socket.on("error", () => {}).destroy();
      throw new RelayConnectError(data.statusCode);
    }
    return data;
  };
  pool.connect = tunnel as Pool["connect"];
  return pool;
}

const agents = new Map<string, ProxyAgent>();

function relayAgent(proxyUrl: string): ProxyAgent {
  let agent = agents.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent({
      // Credentials in the URL are sent as Proxy-Authorization on CONNECT.
      uri: proxyUrl,
      // TCP connect timeout to the relay.
      proxyTls: { timeout: RELAY_CONNECT_TIMEOUT_MS },
      clientFactory: relayClient,
      // No keep-alive: every Bigul call opens its own tunnel, so no idle
      // tunnel goes stale between sign-ins and each call checks its relay.
      pipelining: 0,
    });
    agents.set(proxyUrl, agent);
  }
  return agent;
}

/** Closes the cached relay connections (tests). */
export async function closeRelayAgents() {
  const open = [...agents.values()];
  agents.clear();
  await Promise.all(open.map((agent) => agent.destroy()));
}

function relayFailure(error: unknown): RelayConnectError | null {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof RelayConnectError) return current;
    current = current.cause;
  }
  return null;
}

/** An error code safe to log: never a message, which can hold the relay's address. */
function errorCode(error: unknown): string | undefined {
  if (error instanceof AggregateError) return errorCode(error.errors[0]);
  const code =
    error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : undefined;
}

export type RelayFailure =
  { status: number } | { reason: string; code?: string };

function describe(failure: RelayConnectError): RelayFailure {
  if (failure.status !== undefined) return { status: failure.status };
  const cause = failure.cause;
  const code = errorCode(cause);
  return {
    reason: cause instanceof Error ? cause.name : "unknown",
    ...(code ? { code } : {}),
  };
}

export type RelayRequest = {
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** The call's own deadline; it also bounds every relay attempt. */
  signal: AbortSignal;
};

/**
 * Sends one Bigul call through the relays in order. Moves to the next relay
 * only when a relay could not be reached or did not open the tunnel within
 * RELAY_CONNECT_TIMEOUT_MS (refused, reset, DNS, timeout, or a CONNECT reply
 * other than 200). Once the tunnel is open, whatever happens (any HTTP status,
 * a slow answer, a TLS or connection error) is the call's result. The Bigul
 * calls are an idempotent login and read, so a retry elsewhere is safe.
 * `onRelayDown` gets the relay's 1-based position, never its URL.
 */
export async function fetchThroughRelays(
  relays: readonly string[],
  url: string,
  request: RelayRequest,
  onRelayDown: (relay: number, failure: RelayFailure) => void,
): Promise<{ status: number; text(): Promise<string> }> {
  let lastError: unknown = new Error("No relay configured");
  for (const [index, relay] of relays.entries()) {
    try {
      return await relayFetch(url, {
        ...request,
        dispatcher: relayAgent(relay),
      });
    } catch (error) {
      const failure = relayFailure(error);
      if (!failure) throw error;
      onRelayDown(index + 1, describe(failure));
      if (request.signal.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
