# Agent Chat UI

Agent Chat UI is a Next.js application which enables chatting with any LangGraph server with a `messages` key through a chat interface.

## Shared chat page

The conversation UI follows the finalized shared template (`6294285`) and FinSharpe-Mobile, while retaining Bigul's title, deployment settings, authentication and interactive report host from main. Reports stay beside their originating tool calls; requests and responses remain inspectable, and the iframe retains its state across streamed snapshots.

Conversation history, model selection, recoverable streaming, suggested prompts and citation source previews use the existing LangGraph SDK. Optional model discovery uses `/api/models`; citation PDFs use `/api/filings/pdf`. These requests stay within the configured deployment and use its existing API key and authentication scheme. Generic deployments retain the previous model configuration fallback when the optional catalog is unavailable.

Validation commands: `pnpm test`, `pnpm lint`, `node node_modules/@typescript/typescript6/bin/tsc6 --noEmit`, and `pnpm build`. `tests/support/mock-langgraph-server.mjs` supplies synthetic API fixtures for local browser checks; it does not replace verification against a deployment's actual contract.

## Bigul login

Only verified Bigul clients can use the assistant, and each client sees only their own conversations.

**Flow**

1. A signed-out visitor is sent to `/login`. "Sign in with Bigul" goes to `/auth/login`, which stores a ten-minute state cookie and redirects to Bigul Connect with `app_key`, `state` and `sessionid`. `sessionid` must be our live partner session (`/partner/auth/session-login`): Bigul's login page refuses anything else with "Vendor session is invalid or expired". The session is cached until five minutes before its `expiryTime` (00:30 IST); Bigul hands repeat logins the same session, so every server instance sends the same value.
2. Bigul redirects back to `/auth/callback`. Production Bigul sends `status=success&state=…&access_token=…&client_code=…` (seen 23 Oct 2026); the docs' `login_success`/`token`/`userid` shape is accepted too, and a redirect to the site root is forwarded to the callback unchanged. The callback checks the state, then verifies the login:
   - `access_token` is an HS256 JWT signed by Bigul (not with our secret, so we cannot check the signature). Before any network call, the `client_code` inside it must equal the one in the URL, its `app_key` must be ours, and it must be unexpired. Editing the URL to another client fails here.
   - `GET /auth/connect/get-client-profile?clientCode=…&source=B2B` with `x-api-key`, `x-api-secret` and `Authorization: Bearer <access_token>`, no partner session. Bigul checks the signature and the client: on production it answers 401 "Token authenticate error (client_code mismatch)" for another client's code and 401 for a fake, missing or non-Bearer token. We accept only `status: true` with `data[0].clientcode` equal to the client code (Bigul pads it with a space).
   - `BIGUL_VERIFY_WITH=margin` switches the second step to a one-share margin calculation (`POST /order/user-margin`, nothing placed), the interim check used before the profile endpoint was confirmed.

   Bigul's token is used only for that check and then discarded.
3. On success the app sets `bigul_session` (`__Host-bigul_session` in production), an httpOnly cookie holding an RS256 JWT (`sub` = client code, no other personal data). It expires at 00:30 IST, when Bigul's own tokens do. The state cookie is `bigul_sso_state` (`__Host-bigul_sso_state` in production).
4. `src/proxy.ts` sends signed-out page visits to `/login` and answers signed-out `/api/*` calls with 401. The `/api` route checks the session again, strips client credentials and sends `authorization: Bearer <session JWT>` to LangGraph. bigul-backend verifies it and scopes threads to the client. If LangGraph rejects a session the app accepts, the proxy answers 502 `{"error":"upstream_auth"}` and logs a hint (check `BIGUL_SESSION_PUBLIC_KEY`, `BIGUL_SESSION_ISSUER` and `BIGUL_SESSION_AUDIENCE` on both sides); only the app's own 401 sends the browser to sign in.
5. Sign out (chat header or conversation list) clears the app's `lg:*` browser storage and posts to `/auth/logout`.

**Login errors.** Bigul refusing the login (HTTP 401, `status: false`, or another client's profile) shows "We couldn't confirm your Bigul account" (`?error=verify`). A 403 (API key/secret invalid or IP not whitelisted), 400, 429, 5xx, timeout, no reachable relay or a failed partner login shows "We couldn't reach Bigul" (`?error=unavailable`). A failed partner login at `/auth/login` also shows "We couldn't reach Bigul". The server log (`[bigul-auth]`) gives the status, the reason and Bigul's `message`; it never contains the token, secrets or the partner session id. The platform's own request log does: Bigul puts the client's token (a JWT carrying name, PAN, phone and email) in the redirect's query string, so restrict and shorten request-log retention (see Logging).

**Environment** (server-only, documented in `.env.example`)

| Variable                                                                            | Notes                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BIGUL_SESSION_PRIVATE_KEY` or `BIGUL_SESSION_PRIVATE_KEY_B64`                      | Secret. RS256 private key (PKCS#8 PEM). bigul-backend gets the public key as `BIGUL_SESSION_PUBLIC_KEY`.                                                                                                                                                                                                                                                               |
| `BIGUL_SESSION_ISSUER`, `BIGUL_SESSION_AUDIENCE`                                    | Default `bigul-ui`, `bigul-backend`. Must match the backend.                                                                                                                                                                                                                                                                                                           |
| `BIGUL_SSO_APP_KEY`, `BIGUL_SSO_LOGIN_URL`                                          | Bigul Connect app key; the login URL defaults to `https://connect.bigul.co/login`.                                                                                                                                                                                                                                                                                     |
| `BIGUL_API_KEY`, `BIGUL_API_SECRET`, `BIGUL_PARTNER_CODE`, `BIGUL_PARTNER_PASSWORD` | Secrets for Bigul's partner API.                                                                                                                                                                                                                                                                                                                                       |
| `BIGUL_API_BASE_URL`, `BIGUL_API_SOURCE`                                            | Default `https://papi.bigul.co/api/v1`, `B2B`. UAT is `https://servicestest.bigul.co/api/v1`. Bigul's base URL includes `/api/v1`.                                                                                                                                                                                                                                     |
| `BIGUL_OUTBOUND_PROXY_URLS`                                                         | Optional; secret (holds relay credentials). Relays for the Bigul partner API calls only: comma-separated proxy URLs, primary first, `http://<user>:<password>@<primary-ip>:3128,http://<user>:<password>@<secondary-ip>:3128`. URL-encode special characters in the user name and password (`@` is `%40`). Unset or blank: Bigul is called directly. See step 3 below. |
| `NEXT_PUBLIC_API_URL`, `LANGGRAPH_API_URL`                                          | The browser must go through the proxy: `NEXT_PUBLIC_API_URL=https://<site>/api`, `LANGGRAPH_API_URL` = the LangGraph deployment.                                                                                                                                                                                                                                       |
| `LANGSMITH_API_KEY`                                                                 | Optional, only until bigul-backend's custom auth is live.                                                                                                                                                                                                                                                                                                              |
| `AUTH_DEV_LOGIN`                                                                    | `true` enables `/auth/dev-login` under `next dev` only.                                                                                                                                                                                                                                                                                                                |

A missing variable shows "Sign-in isn't available right now" on the login page; the server log names the variable, never its value.

### Operator checklist

**1. From Bigul** (ask for, or configure, each item before go-live)

- [ ] **Static IPs first.** Whitelist our two outbound IPs (primary and secondary, see step 3). Bigul's partner dashboard only lets you create the app once an IP is whitelisted; creating it then issues `x-api-key` and `x-api-secret` (`BIGUL_API_KEY`, `BIGUL_API_SECRET`).
- [x] **SSO app.** The SSO `app_key` (`BIGUL_SSO_APP_KEY`) is the app's API key (`BIGUL_API_KEY`). The redirect ("postback") URL `https://bigul-ai.vercel.app/auth/callback` is registered on the app in Bigul Connect. A redirect to the site root also works: it is forwarded to the callback.
- [ ] **Partner login.** The partner code (dashboard: Settings > Partner Code; `BIGUL_PARTNER_CODE`) and its password (`BIGUL_PARTNER_PASSWORD`).
- [x] **Answered (23 Oct 2026, tested on production):**
  - Vendor `session-login` needs no TOTP (Bigul confirmed).
  - The SSO `sessionid` must be the partner session id.
  - Repeat `session-login` calls return the existing session ("Existing session found."), so several instances share it; no shared store is needed.
  - `source` is `B2B`. `get-client-profile` is a **GET** (a POST answers 404 "Cannot POST") taking `Authorization: Bearer <token>`; the bare token is refused.

**2. Verification (done on production, 23 Oct 2026).** UAT was skipped by agreement with Bigul. With a real client's token, `get-client-profile` returned the profile for that client and 401 for another client's code, a fake token, no token and a token without `Bearer`. A real sign-in through this app, then chat, worked end to end. Re-run these after any change to the verification code.

**3. Static IPs and Vercel functions**

- [ ] Bigul's production partner API accepts calls only from whitelisted static IPs. `/auth/callback` calls Bigul from this app's server, on the Node.js runtime (it is: Edge functions do not use static IPs). Use Vercel Static IPs (Pro or Enterprise) pinned to one region, which gives exactly two IPs, Bigul's primary and secondary; pin the project's function region to that same region (Project Settings > Functions, or `regions` in `vercel.json`) and leave the failover region off, since it adds a second pair. Alternatively, send the Bigul calls through two relays with fixed IPs (next item).
- [ ] **Relays (`BIGUL_OUTBOUND_PROXY_URLS`), if used instead of Vercel Static IPs.** Each relay is an HTTP forward proxy on a fixed IP (Bigul's primary and secondary) that requires a user name and password and allows `CONNECT` to `papi.bigul.co:443` (and `servicestest.bigul.co:443` for UAT). Set `BIGUL_OUTBOUND_PROXY_URLS=http://<user>:<password>@<primary-ip>:<port>,http://<user>:<password>@<secondary-ip>:<port>`, primary first, URL-encoding special characters in the user name and password. Only the two Bigul partner API calls use the relays; LangGraph and everything else connect directly. Each call opens a `CONNECT` tunnel, so TLS runs end to end between the app and Bigul. A call tries the relays in order and moves to the next only when a relay cannot be reached or does not open the tunnel within 3 s; once the tunnel is open, Bigul's answer stands. Each call keeps its 10 s limit, failover included. The server log line `[bigul-auth] <call> relay unreachable` gives the relay's position (1 = primary) and the error code or the relay's `CONNECT` status, never its address or credentials.
- [ ] Fluid compute must be on (Project Settings > Functions). With it, every plan allows the 300 s the `/api` proxy declares (`maxDuration = 300`; agent answers stream for minutes) and the 60 s of `/auth/callback` (at worst four 10 s Bigul calls, relay failover included). Without it the legacy defaults are 10 s (Hobby) and 15 s (Pro), and Hobby cannot raise a function to 300 s, so long answers would be cut off.

**4. Rollout**

1. **Pre-go-live.** Finish the backend checklist in bigul-backend's README ("Inbound auth: Bigul client login"), steps 1 to 3 above, and the Vercel variables. Generate the key pair with `node scripts/generate-session-keys.mjs`: the private key goes to this app, the public key to bigul-backend. Check whether LangSmith accepts the proxy's LangSmith key and a session bearer together:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST "$LANGGRAPH_API_URL/assistants/search" \
     -H "x-api-key: $KEY" -H "Authorization: Bearer a.b.c" -H 'content-type: application/json' -d '{"limit":1}'
   ```

   200 means step 2 is safe. Anything else means chat shows an error from step 2 until step 3 is live.

2. **Deploy bigul-ui** with the new variables, keeping `LANGSMITH_API_KEY` for now. Per-client conversation scoping only starts at step 3, so keep the gap between the two deploys to minutes.
3. **Deploy bigul-backend custom auth** with `BIGUL_SESSION_PUBLIC_KEY` immediately after, then run its post-deploy checks (in production the session cookie to copy is `__Host-bigul_session`). Threads created before this have no owner and stop appearing in history.
4. **Remove `LANGSMITH_API_KEY`** from the Vercel project, and rotate that LangSmith key.

**5. Local development**

- [ ] Proxy mode is required: `NEXT_PUBLIC_API_URL=http://localhost:3000/api` and `LANGGRAPH_API_URL=http://localhost:2024`. Direct mode (`NEXT_PUBLIC_API_URL=http://localhost:2024`) no longer works: the browser has no session token, so `langgraph dev` with custom auth answers 401 and the chat shows only generic errors.
- [ ] Keys: `node scripts/generate-session-keys.mjs` prints `BIGUL_SESSION_PRIVATE_KEY_B64` for this app's `.env` and `BIGUL_SESSION_PUBLIC_KEY_B64` for bigul-backend's. Use one run for both, or every chat call fails with `upstream_auth`.
- [ ] Sign in with either `AUTH_DEV_LOGIN=true` and the "Development sign-in" form on `/login` under `pnpm dev`, or the mock Bigul Connect server, `node tests/support/mock-bigul-connect.mjs`, with the env listed at the top of that file (`BIGUL_API_BASE_URL=http://127.0.0.1:3300/api/v1`). Open the app on `localhost`, not `127.0.0.1`.

**6. Logging**

- [ ] Bigul's redirect carries the client's token (with name, PAN, phone and email) in the query string of `/` and `/auth/callback`, and the platform logs request URLs (so does `next dev`). The app cannot strip it. Redact query strings on those paths in any log drain, keep request-log access and retention minimal, and ask Bigul whether the token can move out of the URL.

> [!NOTE]
> 🎥 Watch the video setup guide [here](https://youtu.be/lInrwVnZ83o).

## Setup

> [!TIP]
> Don't want to run the app locally? Use the deployed site here: [agentchat.vercel.app](https://agentchat.vercel.app)!

First, clone the repository, or run the [`npx` command](https://www.npmjs.com/package/create-agent-chat-app):

```bash
npx create-agent-chat-app
```

or

```bash
git clone https://github.com/langchain-ai/agent-chat-ui.git

cd agent-chat-ui
```

Install dependencies:

```bash
pnpm install
```

Run the app:

```bash
pnpm dev
```

The app will be available at `http://localhost:3000`.

## Usage

Once the app is running (or if using the deployed site), you'll be prompted to enter:

- **Deployment URL**: The URL of the LangGraph server you want to chat with. This can be a production or development URL.
- **Assistant/Graph ID**: The name of the graph, or ID of the assistant to use when fetching, and submitting runs via the chat interface.
- **LangSmith API Key**: (only required for connecting to deployed LangGraph servers) Your LangSmith API key to use when authenticating requests sent to LangGraph servers.
- **Built with Agent Builder**: Toggle this on for Agent Builder deployments. This automatically sets the auth scheme to `langsmith-api-key`.

After entering these values, click `Continue`. You'll then be redirected to a chat interface where you can start chatting with your LangGraph server.

## Environment Variables

You can bypass the initial setup form by setting the following environment variables:

```bash
# This app's /api proxy (required for Bigul login), forwarding to langgraph dev.
NEXT_PUBLIC_API_URL=http://localhost:3000/api
LANGGRAPH_API_URL=http://localhost:2024
NEXT_PUBLIC_ASSISTANT_ID=agent
NEXT_PUBLIC_AUTH_SCHEME=
```

> [!NOTE]
> If you are connecting to a LangSmith Agent Builder deployment, set `NEXT_PUBLIC_AUTH_SCHEME=langsmith-api-key`.

> [!TIP]
> If you want to connect to a production LangGraph server, read the [Going to Production](#going-to-production) section.

To use these variables:

1. Copy the `.env.example` file to a new file named `.env`
2. Fill in the values in the `.env` file
3. Restart the application

When these environment variables are set, the application will use them instead of showing the setup form.

## Hiding Messages in the Chat

You can control the visibility of messages within the Agent Chat UI in two main ways:

**1. Prevent Live Streaming:**

To stop messages from being displayed _as they stream_ from an LLM call, add the `langsmith:nostream` tag to the chat model's configuration. The UI normally uses `on_chat_model_stream` events to render streaming messages; this tag prevents those events from being emitted for the tagged model.

_Python Example:_

```python
from langchain_anthropic import ChatAnthropic

# Add tags via the .with_config method
model = ChatAnthropic().with_config(
    config={"tags": ["langsmith:nostream"]}
)
```

_TypeScript Example:_

```typescript
import { ChatAnthropic } from "@langchain/anthropic";

const model = new ChatAnthropic()
  // Add tags via the .withConfig method
  .withConfig({ tags: ["langsmith:nostream"] });
```

**Note:** Even if streaming is hidden this way, the message will still appear after the LLM call completes if it's saved to the graph's state without further modification.

**2. Hide Messages Permanently:**

To ensure a message is _never_ displayed in the chat UI (neither during streaming nor after being saved to state), prefix its `id` field with `do-not-render-` _before_ adding it to the graph's state, along with adding the `langsmith:do-not-render` tag to the chat model's configuration. The UI explicitly filters out any message whose `id` starts with this prefix.

_Python Example:_

```python
result = model.invoke([messages])
# Prefix the ID before saving to state
result.id = f"do-not-render-{result.id}"
return {"messages": [result]}
```

_TypeScript Example:_

```typescript
const result = await model.invoke([messages]);
// Prefix the ID before saving to state
result.id = `do-not-render-${result.id}`;
return { messages: [result] };
```

This approach guarantees the message remains completely hidden from the user interface.

## Rendering Artifacts

The Agent Chat UI supports rendering artifacts in the chat. Artifacts are rendered in a side panel to the right of the chat. To render an artifact, you can obtain the artifact context from the `thread.meta.artifact` field. Here's a sample utility hook for obtaining the artifact context:

```tsx
export function useArtifact<TContext = Record<string, unknown>>() {
  type Component = (props: {
    children: React.ReactNode;
    title?: React.ReactNode;
  }) => React.ReactNode;

  type Context = TContext | undefined;

  type Bag = {
    open: boolean;
    setOpen: (value: boolean | ((prev: boolean) => boolean)) => void;

    context: Context;
    setContext: (value: Context | ((prev: Context) => Context)) => void;
  };

  const thread = useStreamContext<
    { messages: Message[]; ui: UIMessage[] },
    { MetaType: { artifact: [Component, Bag] } }
  >();

  return thread.meta?.artifact;
}
```

After which you can render additional content using the `Artifact` component from the `useArtifact` hook:

```tsx
import { useArtifact } from "../utils/use-artifact";
import { LoaderIcon } from "lucide-react";

export function Writer(props: {
  title?: string;
  content?: string;
  description?: string;
}) {
  const [Artifact, { open, setOpen }] = useArtifact();

  return (
    <>
      <div
        onClick={() => setOpen(!open)}
        className="cursor-pointer rounded-lg border p-4"
      >
        <p className="font-medium">{props.title}</p>
        <p className="text-sm text-gray-500">{props.description}</p>
      </div>

      <Artifact title={props.title}>
        <p className="whitespace-pre-wrap p-4">{props.content}</p>
      </Artifact>
    </>
  );
}
```

## Going to Production

Once you're ready to go to production, you'll need to update how you connect, and authenticate requests to your deployment. By default, the Agent Chat UI is setup for local development, and connects to your LangGraph server directly from the client. This is not possible if you want to go to production, because it requires every user to have their own LangSmith API key, and set the LangGraph configuration themselves.

### Production Setup

To productionize the Agent Chat UI, you'll need to pick one of two ways to authenticate requests to your LangGraph server. Below, I'll outline the two options:

### Quickstart - API Passthrough

The quickest way to productionize the Agent Chat UI is to use the [API Passthrough](https://github.com/bracesproul/langgraph-nextjs-api-passthrough) package ([NPM link here](https://www.npmjs.com/package/langgraph-nextjs-api-passthrough)). This package provides a simple way to proxy requests to your LangGraph server, attaching your LangSmith API key on the server so your users never need one. It does not authenticate the callers of that proxy for you — see [Authenticating the API Passthrough](#authenticating-the-api-passthrough) below, which you should set up before deploying.

This repository already contains the proxy route itself. The only configuration you need to do is set the proper environment variables.

```bash
NEXT_PUBLIC_ASSISTANT_ID="agent"
# This should be the deployment URL of your LangGraph server
LANGGRAPH_API_URL="https://my-agent.default.us.langgraph.app"
# This should be the URL of your website + "/api". This is how you connect to the API proxy
NEXT_PUBLIC_API_URL="https://my-website.com/api"
# Your LangSmith API key which is injected into requests inside the API proxy
LANGSMITH_API_KEY="lsv2_..."
```

Let's cover what each of these environment variables does:

- `NEXT_PUBLIC_ASSISTANT_ID`: The ID of the assistant you want to use when fetching, and submitting runs via the chat interface. This still needs the `NEXT_PUBLIC_` prefix, since it's not a secret, and we use it on the client when submitting requests.
- `LANGGRAPH_API_URL`: The URL of your LangGraph server. This should be the production deployment URL.
- `NEXT_PUBLIC_API_URL`: The URL of your website + `/api`. This is how you connect to the API proxy. For the [Agent Chat demo](https://agentchat.vercel.app), this would be set as `https://agentchat.vercel.app/api`. You should set this to whatever your production URL is.
- `LANGSMITH_API_KEY`: Your LangSmith API key to use when authenticating requests sent to LangGraph servers. Once again, do _not_ prefix this with `NEXT_PUBLIC_` since it's a secret, and is only used on the server when the API proxy injects it into the request to your deployed LangGraph server.

For in depth documentation, consult the [LangGraph Next.js API Passthrough](https://www.npmjs.com/package/langgraph-nextjs-api-passthrough) docs.

### Authenticating the API Passthrough

> [!WARNING]
> The API passthrough does not authenticate your callers. If you deploy this repository with `LANGGRAPH_API_URL` and `LANGSMITH_API_KEY` set and no gate of your own, anyone who reaches your deployment URL can read, overwrite, and delete every thread and store item in your LangGraph deployment, and start runs billed to your LangSmith account.

Before you deploy, set up [custom authentication](#advanced-setup---custom-authentication) on your LangGraph deployment and delete `src/app/api/[..._path]/route.ts`, so your LangSmith key never sits behind a public route.

This repository instead gates the passthrough with a Bigul session; see [Bigul login](#bigul-login).

### Advanced Setup - Custom Authentication

Custom authentication in your LangGraph deployment is an advanced, and more robust way of authenticating requests to your LangGraph server. Using custom authentication, you can allow requests to be made from the client, without the need for a LangSmith API key. Additionally, you can specify custom access controls on requests.

To set this up in your LangGraph deployment, please read the LangGraph custom authentication docs for [Python](https://langchain-ai.github.io/langgraph/tutorials/auth/getting_started/), and [TypeScript here](https://langchain-ai.github.io/langgraphjs/how-tos/auth/custom_auth/).

Once you've set it up on your deployment, you should make the following changes to the Agent Chat UI:

1. Configure any additional API requests to fetch the authentication token from your LangGraph deployment which will be used to authenticate requests from the client.
2. Set the `NEXT_PUBLIC_API_URL` environment variable to your production LangGraph deployment URL.
3. Set the `NEXT_PUBLIC_ASSISTANT_ID` environment variable to the ID of the assistant you want to use when fetching, and submitting runs via the chat interface.
4. Modify the [`useTypedStream`](src/providers/Stream.tsx) (extension of `useStream`) hook to pass your authentication token through headers to the LangGraph server:

```tsx
const streamValue = useTypedStream({
  apiUrl: process.env.NEXT_PUBLIC_API_URL,
  assistantId: process.env.NEXT_PUBLIC_ASSISTANT_ID,
  // ... other fields
  defaultHeaders: {
    Authentication: `Bearer ${addYourTokenHere}`, // this is where you would pass your authentication token
  },
});
```
