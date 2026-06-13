# Nexus Shell — Integration Setup Guides

Both Instagram and TikTok only allow login through their **official OAuth**
with a developer app you register yourself. That's a platform rule, not an
app limitation — any tool that skips it is using your password against their
terms. Each registration takes ~10 minutes and is free.

Once you have the keys: **Settings → Social accounts → Setup → paste keys →
Connect**. The login happens in your own browser on the platform's page;
Nexus Shell only ever receives the access token (stored in your Keychain).

---

## § instagram-meta — Instagram (via Meta Graph API)

Posting to Instagram through the official API requires an **Instagram
professional account** (Business or Creator — free to switch in the
Instagram app) linked to a **Facebook Page**.

1. **Create the Meta app**
   - Go to <https://developers.facebook.com/apps> → **Create App**
   - Use case: **Other** → type: **Business** → name it (e.g. `Nexus Shell`)
2. **Add Facebook Login**
   - In the app dashboard: **Add product → Facebook Login → Set up**
   - Skip the quickstart; go to **Facebook Login → Settings** and add this
     **Valid OAuth Redirect URI**:
     ```
     http://localhost:38427/callback
     ```
     (Localhost redirects are allowed while the app is in Development Mode —
     which is all you need for posting from your own account.)
3. **Link your Instagram**
   - Make sure your Instagram account is **Professional** (Instagram app →
     Settings → Account type) and linked to a Facebook Page you admin
     (Page settings → Linked accounts).
4. **Get the keys**
   - App dashboard → **App settings → Basic** → copy **App ID** and
     **App Secret**
5. **In Nexus Shell**
   - Settings → Social accounts → Instagram → **Setup** → paste App ID +
     App Secret → **Save keys** → **Connect**
   - Your browser opens Facebook's consent page. Approve the permissions
     (pages + instagram basic + content publish). The tab will say
     "✓ Connected" when done.

> Development Mode is fine for posting to accounts that have a role on the
> app (you). Publishing for *other* people's accounts would require Meta's
> App Review — not needed here.

---

## § gmail-google — Gmail (Google OAuth 2.0)

1. **Create a Google Cloud project**
   - <https://console.cloud.google.com> → project picker → **New project**
     (e.g. `Nexus Shell`)
2. **Enable the Gmail API**
   - **APIs & Services → Library** → search "Gmail API" → **Enable**
3. **Configure the consent screen**
   - **APIs & Services → OAuth consent screen** → External → fill the app
     name + your email → add **yourself as a Test user** (no verification
     needed while in Testing mode)
   - Scopes: you can leave this blank — the app requests
     `gmail.readonly` and `gmail.send` at login time
4. **Create the credentials**
   - **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Desktop app** ← important (this is what permits the
     localhost loopback redirect, no URI registration needed)
   - Copy the **Client ID** and **Client Secret**
5. **In Nexus Shell**
   - Settings → Connected accounts → Gmail → **Setup** → paste Client ID +
     Client Secret → **Save keys** → **Connect**
   - Your browser opens Google's sign-in. Pick the account, approve the
     Gmail permissions (you'll see an "unverified app" warning while in
     Testing mode — that's your own app, hit *Continue*).

> Tokens include an offline refresh token, so the connection persists past
> the 1-hour access-token expiry.

---

## § tiktok — TikTok (Login Kit + Content Posting API)

1. **Register as a developer**
   - <https://developers.tiktok.com> → log in with your TikTok → **Manage apps
     → Connect an app**
2. **Configure the app**
   - Add products: **Login Kit** and **Content Posting API**
   - Scopes: `user.info.basic`, `video.upload`, `video.publish`
   - Login Kit → **Redirect URI**, add exactly:
     ```
     http://localhost:38428/callback
     ```
3. **Get the keys**
   - From the app detail page copy **Client Key** and **Client Secret**
   - Submit the app for review if TikTok requires it for the posting scopes
     (sandbox mode works for your own account in the meantime — add your
     TikTok username as a target user under "Sandbox")
4. **In Nexus Shell**
   - Settings → Social accounts → TikTok → **Setup** → paste Client Key +
     Client Secret → **Save keys** → **Connect**
   - Browser opens TikTok's consent page; approve and return.

---

## § github — GitHub (OAuth App)

1. **Create the OAuth app**
   - <https://github.com/settings/developers> → **OAuth Apps → New OAuth App**
   - Application name: `Nexus Shell` · Homepage: anything (e.g. `http://localhost`)
   - **Authorization callback URL** — exactly:
     ```
     http://127.0.0.1:38430/callback
     ```
2. **Get the keys**
   - After creating: copy the **Client ID**, then **Generate a new client
     secret** and copy it
3. **In Nexus Shell**
   - CONNECT tab → GitHub → **Setup** → paste Client ID + Client Secret →
     **Save keys** → **Connect**
   - Browser opens GitHub's authorize page (scopes: repos + profile + email).
     The row flips to ✓ your-username.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "redirect_uri mismatch" | The URI in the dev console must be EXACTLY `http://localhost:38427/callback` (IG) / `:38428` (TikTok) — no trailing slash differences. |
| "'instagram_client_id' not configured" | Hit **Setup** on the row and save the keys first. |
| Browser shows the consent page but the app says "timed out" | Finish the login within 4 minutes, and don't close the localhost tab before it says ✓ Connected. |
| Meta error about app mode | Keep the app in **Development Mode** and make sure you're logging in with the account that owns the app. |
| TikTok "scope not authorized" | Add the scopes in the dev console AND (sandbox) add your username as a sandbox target user. |

## Security model

- **No passwords**: login happens on instagram/tiktok's own pages in your browser.
- **Keychain only**: client keys and access tokens are stored in the macOS
  Keychain under the `nexus-shell` service — never on disk in plaintext.
- **Loopback**: the one-shot localhost listener only accepts the single
  OAuth redirect and immediately closes.
