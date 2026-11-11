// The common CityScroll account sign-in shell, served by the engine at
// https://cityscroll.org/account and /account/confirm. Civic and procurement
// sign-in buttons both open this same shell; it posts to the canonical
// api.cityscroll.org issuer, so the browser Origin stays https://cityscroll.org.
//
// The confirmation shell reads the one-use token from the URL fragment into
// memory, immediately clears it from the address bar (replaceState), and only
// sends it on an explicit Continue click — never on load, so an email scanner's
// GET cannot consume the link. No analytics, no referrer.
//
// Inert until CITYSCROLL_ACCOUNTS_ENABLED is "true": otherwise it 404s.

import { accountsEnabled } from "./account.mjs";

const AUTH_BASE = "https://api.cityscroll.org/account/v1";

function nonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pageResponse(html, scriptNonce) {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": [
        "default-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "img-src 'self' data:",
        "style-src 'unsafe-inline'",
        `script-src 'nonce-${scriptNonce}'`,
        "connect-src https://api.cityscroll.org",
      ].join("; "),
    },
  });
}

const SHELL_STYLE = `
  body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:0 auto;padding:2rem 1rem;color:#111;background:#fff}
  h1{font-size:1.4rem}
  .card{border:1px solid #d7d7d7;border-radius:12px;padding:1.25rem;margin-top:1rem}
  label{display:block;font-weight:600;margin-bottom:.35rem}
  input[type=email]{width:100%;box-sizing:border-box;padding:.6rem;border:1px solid #bbb;border-radius:8px;font:inherit}
  button{margin-top:1rem;padding:.6rem 1.1rem;border:0;border-radius:8px;background:#0a4;color:#fff;font:inherit;font-weight:600;cursor:pointer}
  .muted{color:#555;font-size:.95rem}
  .status{margin-top:1rem;font-weight:600}
`;

function signInShell(scriptNonce) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>Sign in to CityScroll</title><style>${SHELL_STYLE}</style></head>
<body><h1>Sign in to CityScroll</h1>
<p class="muted">One CityScroll account, by email. The same account works across the civic site and Waypoint. We send a one-time sign-in link; there is no password, and this does not sign you up for any email updates.</p>
<div class="card">
  <label for="email">Email address</label>
  <input id="email" type="email" autocomplete="email" inputmode="email" placeholder="Your email address">
  <div id="turnstile"></div>
  <button id="continue" type="button">Continue</button>
  <p id="status" class="status" role="status" aria-live="polite"></p>
</div>
<script nonce="${scriptNonce}">
  (function(){
    var btn=document.getElementById('continue'),status=document.getElementById('status'),email=document.getElementById('email');
    btn.addEventListener('click',function(){
      var value=(email.value||'').trim();
      if(!value||value.indexOf('@')<0){status.textContent='Enter a complete email address.';return;}
      btn.disabled=true;status.textContent='Sending your sign-in link…';
      fetch('${AUTH_BASE}/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({email:value,operationId:(crypto.randomUUID?crypto.randomUUID():String(Date.now())),turnstileToken:(window.__cs_turnstile||'')})})
        .then(function(){status.textContent='If that address can sign in, we just sent a link. Open it in this browser to continue.';})
        .catch(function(){btn.disabled=false;status.textContent='Could not send a link right now. Please try again shortly.';});
    });
  })();
</script>
</body></html>`;
}

function confirmShell(scriptNonce) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>Finish signing in</title><style>${SHELL_STYLE}</style></head>
<body><h1>Finish signing in</h1>
<div class="card">
  <p class="muted">For your security, finishing sign-in is an explicit step. Open this link in the same browser where you started.</p>
  <button id="continue" type="button">Continue to CityScroll</button>
  <p id="status" class="status" role="status" aria-live="polite"></p>
  <p id="recover" class="muted" hidden><a href="/account">Request a new sign-in link</a></p>
</div>
<script nonce="${scriptNonce}">
  (function(){
    var token='';var h=window.location.hash||'';
    if(h.indexOf('token=')>=0){try{token=decodeURIComponent(h.split('token=')[1].split('&')[0]);}catch(e){token='';}}
    // Clear the one-use token from the address bar immediately; keep it only in memory.
    try{history.replaceState(null,'',window.location.pathname);}catch(e){}
    var btn=document.getElementById('continue'),status=document.getElementById('status'),recover=document.getElementById('recover');
    if(!token){status.textContent='This sign-in link is missing or already used.';recover.hidden=false;btn.disabled=true;return;}
    btn.addEventListener('click',function(){
      btn.disabled=true;status.textContent='Signing you in…';
      fetch('${AUTH_BASE}/confirm',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token})})
        .then(function(r){if(r.ok)return r.json();throw new Error('failed');})
        .then(function(){token='';status.textContent='You are signed in. You can return to CityScroll or Waypoint.';})
        .catch(function(){token='';status.textContent='That link is expired or already used.';recover.hidden=false;});
    });
  })();
</script>
</body></html>`;
}

export function handleAccountPage(req, env, pathname) {
  if (!accountsEnabled(env)) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
  const scriptNonce = nonce();
  if (pathname === "/account" || pathname === "/account/") return pageResponse(signInShell(scriptNonce), scriptNonce);
  if (pathname === "/account/confirm") return pageResponse(confirmShell(scriptNonce), scriptNonce);
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
}
