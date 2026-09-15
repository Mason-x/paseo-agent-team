import { randomUUID } from "node:crypto";
import type { RpcInput } from "@getpaseo/plugin";
import type { openOmpMcpAuthorizationInPaseoBrowser } from "../shared/mcp";
import { OmpPublicError } from "./provider/security";

const MAX_REGISTERED_SESSIONS = 32;
const MAX_AUTHORIZATIONS_PER_SESSION = 16;

type BrowserAuthorizationOpener = (url: string) => Promise<void>;

type RegisteredSession = {
  token: symbol;
  open: BrowserAuthorizationOpener;
  authorizations: Set<string>;
};

type RegisteredAuthorization = {
  agentId: string;
  sessionToken: symbol;
  url: string;
  open: BrowserAuthorizationOpener;
};

export interface OmpBrowserAuthorizationRegistration {
  issue(url: string): string | undefined;
  remove(): void;
}

export class OmpBrowserAuthorizationRegistry {
  private readonly sessions = new Map<string, RegisteredSession>();
  private readonly authorizations = new Map<string, RegisteredAuthorization>();

  register(agentId: string, open: BrowserAuthorizationOpener): OmpBrowserAuthorizationRegistration {
    if (this.sessions.has(agentId)) {
      throw new OmpPublicError("OMP browser authorization is already registered for this agent");
    }
    if (this.sessions.size >= MAX_REGISTERED_SESSIONS) {
      throw new OmpPublicError("OMP browser authorization session limit reached");
    }
    const session: RegisteredSession = { token: Symbol(agentId), open, authorizations: new Set() };
    this.sessions.set(agentId, session);

    return {
      issue: (url) => {
        if (this.sessions.get(agentId) !== session) return;
        if (session.authorizations.size >= MAX_AUTHORIZATIONS_PER_SESSION) {
          const oldest = session.authorizations.values().next().value;
          if (oldest) {
            session.authorizations.delete(oldest);
            this.authorizations.delete(oldest);
          }
        }
        const authorizationToken = randomUUID();
        session.authorizations.add(authorizationToken);
        this.authorizations.set(authorizationToken, {
          agentId,
          sessionToken: session.token,
          url,
          open,
        });
        return authorizationToken;
      },
      remove: () => {
        if (this.sessions.get(agentId) !== session) return;
        this.sessions.delete(agentId);
        for (const authorizationToken of session.authorizations) {
          this.authorizations.delete(authorizationToken);
        }
        session.authorizations.clear();
      },
    };
  }

  async open(authorizationToken: string): Promise<void> {
    const authorization = this.authorizations.get(authorizationToken);
    const session = authorization ? this.sessions.get(authorization.agentId) : undefined;
    if (!authorization || session?.token !== authorization.sessionToken) {
      throw new OmpPublicError("The OMP browser authorization is no longer available");
    }
    await authorization.open(authorization.url);
  }

  clear(): void {
    this.authorizations.clear();
    this.sessions.clear();
  }
}

export async function resolveOpenOmpMcpAuthorizationInPaseoBrowser(
  input: RpcInput<typeof openOmpMcpAuthorizationInPaseoBrowser>,
  registry: OmpBrowserAuthorizationRegistry,
): Promise<{ opened: true }> {
  await registry.open(input.authorizationToken);
  return { opened: true };
}
