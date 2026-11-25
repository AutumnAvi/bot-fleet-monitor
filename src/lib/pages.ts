// Server-rendered HTML: the login page and the app shell. No data is embedded;
// the app shell loads /assets/app.js which fetches /api/* with the session cookie.

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="same-origin">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">`;

export function loginPage(error: string | null = null): string {
  const alert = error
    ? `<p class="login-error" role="alert">${escapeHtml(error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
${HEAD}
<title>Bot Fleet · Sign in</title>
<link rel="stylesheet" href="/assets/login.css">
</head>
<body>
<main class="login-card">
  <h1>Bot Fleet</h1>
  <p class="login-sub">Avi's Work and Admin. Bots push; this page never wakes them.</p>
  ${alert}
  <form method="post" action="/login">
    <input type="text" name="username" value="avi" autocomplete="username" hidden>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus maxlength="256">
    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>`;
}

export function appShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
${HEAD}
<title>Bot Fleet</title>
<link rel="stylesheet" href="/assets/app.css">
<script type="module" src="/assets/app.js"></script>
</head>
<body>
<div id="app"><p class="boot">Loading Bot Fleet…</p></div>
<noscript><p class="boot">Bot Fleet needs JavaScript.</p></noscript>
</body>
</html>`;
}
