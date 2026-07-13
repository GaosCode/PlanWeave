import { resolveToken } from "./auth.js";

export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly response?: unknown,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

async function ghRequest<T>(
  path: string,
  options: RequestInit & { token?: string } = {},
): Promise<T> {
  const token = options.token ?? await resolveToken();
  if (!token) {
    throw new GitHubError(
      "GitHub token not configured. Run 'planweave gh login' or set PLANWEAVE_GITHUB_TOKEN.",
    );
  }

  const url = path.startsWith("https://") ? path : `https://api.github.com${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "PlanWeave",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GitHubError(
      `GitHub API error (${response.status}): ${body || response.statusText}`,
      response.status,
      body,
    );
  }

  return response.json() as Promise<T>;
}

export { ghRequest };
