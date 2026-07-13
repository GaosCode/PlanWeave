import { execFile, exec } from "node:child_process";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export interface TokenStatus {
  authenticated: boolean;
  login: string | null;
  scopes: string[];
  source: "env" | "planweave_store" | "gh_cli" | "git_credential" | null;
}

export interface AuthStore {
  token: string;
  login: string;
  scopes: string[];
  createdAt: string;
}

function planweaveConfigDir(): string {
  const home = process.env.PLANWEAVE_HOME ?? homedir();
  return join(home, ".planweave");
}

function authFilePath(): string {
  return join(planweaveConfigDir(), "github-auth.json");
}

export async function loadAuthStore(): Promise<AuthStore | null> {
  try {
    const raw = await readFile(authFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as AuthStore;
    if (parsed.token && typeof parsed.token === "string" && parsed.token.trim()) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveAuthStore(store: AuthStore): Promise<void> {
  const dir = planweaveConfigDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(authFilePath(), JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export async function clearAuthStore(): Promise<void> {
  try {
    await unlink(authFilePath());
  } catch {
    // file doesn't exist, that's fine
  }
}

async function getGhCliToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      timeout: 10_000,
    });
    return stdout.trim() || null;
  } catch {
    try {
      const hostsPath = join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        "gh",
        "hosts.yml",
      );
      const raw = await readFile(hostsPath, "utf-8");
      const match = raw.match(/oauth_token:\s*(\S+)/);
      return match?.[1]?.trim() || null;
    } catch {
      return null;
    }
  }
}

async function getGitCredentialToken(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `echo "url=https://github.com\\n\\n" | git credential fill`,
      { timeout: 10_000 },
    );
    const match = stdout.match(/^password=(.+)$/m);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

async function fetchLoginAndScopes(token: string): Promise<{ login: string; scopes: string[] }> {
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "PlanWeave",
      },
    });

    if (!response.ok) {
      return { login: "unknown", scopes: [] };
    }

    const user = (await response.json()) as { login?: string };
    const scopesHeader = response.headers.get("X-OAuth-Scopes");
    const scopes = scopesHeader ? scopesHeader.split(",").map((s) => s.trim()) : [];

    return { login: user.login ?? "unknown", scopes };
  } catch {
    return { login: "unknown", scopes: [] };
  }
}

export async function resolveToken(): Promise<string> {
  const envToken = process.env.PLANWEAVE_GITHUB_TOKEN?.trim();
  if (envToken) return envToken;

  const store = await loadAuthStore();
  if (store?.token) return store.token;

  const ghToken = await getGhCliToken();
  if (ghToken) return ghToken;

  const credentialToken = await getGitCredentialToken();
  if (credentialToken) return credentialToken;

  throw new Error(
    "GitHub token not found. Run 'planweave gh login' or set PLANWEAVE_GITHUB_TOKEN.",
  );
}

export async function getTokenSource(): Promise<"env" | "planweave_store" | "gh_cli" | "git_credential" | null> {
  if (process.env.PLANWEAVE_GITHUB_TOKEN?.trim()) return "env";
  if (await loadAuthStore()) return "planweave_store";
  if (await getGhCliToken()) return "gh_cli";
  if (await getGitCredentialToken()) return "git_credential";
  return null;
}

export async function getTokenStatus(): Promise<TokenStatus> {
  const envToken = process.env.PLANWEAVE_GITHUB_TOKEN?.trim();
  if (envToken) {
    const { login, scopes } = await fetchLoginAndScopes(envToken);
    return { authenticated: true, login, scopes, source: "env" };
  }

  const store = await loadAuthStore();
  if (store?.token) {
    return { authenticated: true, login: store.login, scopes: store.scopes, source: "planweave_store" };
  }

  const ghToken = await getGhCliToken();
  if (ghToken) {
    const { login, scopes } = await fetchLoginAndScopes(ghToken);
    return { authenticated: true, login, scopes, source: "gh_cli" };
  }

  const credentialToken = await getGitCredentialToken();
  if (credentialToken) {
    const { login, scopes } = await fetchLoginAndScopes(credentialToken);
    return { authenticated: true, login, scopes, source: "git_credential" };
  }

  return { authenticated: false, login: null, scopes: [], source: null };
}
