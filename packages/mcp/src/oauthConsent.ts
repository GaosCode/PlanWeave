export type ConsentPageParams = {
  clientId: string;
  codeChallenge: string;
  csrfNonce: string;
  redirectUri: string;
  resource: string;
  scope: string;
  state: string | null;
};

export function consentPage(params: ConsentPageParams): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize PlanWeave MCP</title>
  <style>
    body { color: #171717; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 40px; }
    main { max-width: 560px; }
    p { color: #525252; line-height: 1.5; }
    button { background: #171717; border: 0; border-radius: 8px; color: #fff; cursor: pointer; font: inherit; padding: 10px 16px; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize PlanWeave MCP</h1>
    <p>Allow this ChatGPT connection to access the local PlanWeave MCP server.</p>
    <form method="post" action="/oauth/authorize/confirm">
      ${hiddenInput("response_type", "code")}
      ${hiddenInput("client_id", params.clientId)}
      ${hiddenInput("redirect_uri", params.redirectUri)}
      ${hiddenInput("resource", params.resource)}
      ${hiddenInput("code_challenge", params.codeChallenge)}
      ${hiddenInput("code_challenge_method", "S256")}
      ${hiddenInput("scope", params.scope)}
      ${hiddenInput("csrf_nonce", params.csrfNonce)}
      ${params.state ? hiddenInput("state", params.state) : ""}
      <button type="submit">Allow</button>
    </form>
  </main>
</body>
</html>`;
}

export function errorPage(error: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>PlanWeave MCP OAuth error</title></head>
<body><h1>OAuth error</h1><p>${escapeHtml(error)}</p></body>
</html>`;
}

function hiddenInput(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
