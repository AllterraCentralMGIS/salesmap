# SalesMap (web)

Browser-based, mobile-friendly customer map + visit tracker for field sales teams.
Static frontend hosted on GitHub Pages, Supabase for shared backend.

**Live URL (once deployed):** https://allterracentralmgis.github.io/salesmap/

---

## One-time setup checklist

Do these in order. Each step is 2–10 min.

### 1. Apply the database schema

1. Open your Supabase project: https://supabase.com/dashboard/project/klkjpwgjnaozhatfopvd
2. Left sidebar → **SQL Editor** → **New query**
3. Open `supabase/001_init.sql` from this repo, copy the whole file, paste, click **Run**
4. Look for "Success. No rows returned." at the bottom

### 2. Make yourself an admin (after you sign up — see step 6)

After you've signed up and verified your email:
1. SQL Editor → New query
2. Paste this with your email substituted:
   ```sql
   update public.profiles set role = 'admin'
   where id = (select id from auth.users where email = 'you@example.com');
   ```
3. Run. Without this you can't import zones (zones are admin-write).

### 3. Disable public signup (invite-only)

1. Supabase Dashboard → **Authentication → Sign In / Up → Sign In Providers**
2. Find **Email** → toggle **Allow new users to sign up** to **off**
3. Now only people you invite from the dashboard can log in

### 4. Lock your TomTom API key to this domain

1. Sign in at https://developer.tomtom.com
2. Your API keys → click your key → **Restrict key**
3. Allowed HTTP referrers — add:
   - `https://allterracentralmgis.github.io/*`
   - `http://localhost/*` (for local testing)
4. Save

### 5. Deploy to GitHub Pages

```bash
cd /Users/miguelmanning/salesmap-web
git init
git add .
git commit -m "Initial commit"

# Create a new public repo named "salesmap" under the allterracentralmgis account on GitHub.com first.
git branch -M main
git remote add origin https://github.com/allterracentralmgis/salesmap.git
git push -u origin main
```

On GitHub:
1. Repo → **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: **main** / Folder: **/ (root)** → Save
4. Wait 1–2 minutes; the page reports the URL: `https://allterracentralmgis.github.io/salesmap/`

### 6. Sign yourself up + invite colleagues

You disabled signup in step 3, so the standard sign-up flow won't work. Instead:

1. Supabase Dashboard → **Authentication → Users → Invite User**
2. Enter the email → click Invite
3. The user gets an email with a magic link → they set a password → done

Invite yourself first. Then go back to step 2 and promote yourself to admin.

Once admin, sign in at the URL from step 5 and open Settings (gear icon):
- Enter your TomTom API key (it's saved to your browser's local storage)
- Set your display name and salesperson code
- Click **Load zones (KML)** → pick your zones KML
- Click **Import customers (Excel)** → pick your customer list
- (Optional) **Import visit history (Excel)** → backfill past visits

Now invite your colleagues from the Supabase dashboard. They'll log in, see the same map, and start logging visits.

---

## How phone access works

The site is responsive. On a phone:
- The map fills the screen
- Tap the **≡** button (top-left) to open the customer list and filters
- Tap a customer → detail sheet slides in
- Tap **+ Log visit** to record a stop, even in the field

For an app-like experience, your colleagues can:
- **iPhone (Safari)**: Share button → **Add to Home Screen**
- **Android (Chrome)**: Menu → **Install app** (or **Add to Home Screen**)

The icon appears alongside their other apps; opening it goes full-screen, no browser chrome.

---

## File layout

```
salesmap-web/
├── index.html                # entry point
├── config.js                 # Supabase URL + anon key (safe to commit)
├── styles.css                # all styles, responsive
├── manifest.json             # PWA install metadata
├── sw.js                     # minimal service worker (PWA install)
├── icons/
│   └── icon.svg              # app icon
├── js/
│   └── app.js                # entire app — auth, map, list, importers, etc.
├── supabase/
│   └── 001_init.sql          # database schema + RLS policies
└── README.md
```

No build step. Edit a file, push to GitHub, Pages redeploys in ~60 seconds.

---

## Local dev (optional)

Anything that serves static files works. Easiest:

```bash
cd /Users/miguelmanning/salesmap-web
python3 -m http.server 5173
open http://localhost:5173
```

Or use the VS Code "Live Server" extension. Service workers and PWA install only work over HTTPS or `localhost`, both of which apply here.

---

## Permissions model

| Action | Anyone signed in | Creator | Admin |
|---|---|---|---|
| See customers + visits + zones | ✓ | ✓ | ✓ |
| Add a customer | ✓ | ✓ | ✓ |
| Edit a customer | ✓ | ✓ | ✓ |
| Delete a customer | — | ✓ | ✓ |
| Log a visit | ✓ (as self) | ✓ | ✓ |
| Edit / delete a visit | — | ✓ (own) | ✓ |
| Load / replace zones (KML) | — | — | ✓ |

So a typical rep can do everything except delete customers and replace zones. Promote multiple admins if you want shared territory management.

---

## Migrating existing Electron data to Supabase

Not yet automated — if you want to keep the visit history you've logged in the desktop app, ping me and I'll write a one-off script that reads from the SQLite file and uploads via the service_role key.

---

## Troubleshooting

**Map shows blank with a CSP / connect-src error** — already handled in the CSP. If you forked this and tightened the policy, re-allow `blob:` for `connect-src`.

**"new row violates row-level security policy"** when importing zones — you're not admin. See step 2.

**Sign-in says "Invalid login credentials"** — make sure the user was invited and has set their password via the invite email link.

**Custom domain** — Supabase isn't tied to your domain. If you want `salesmap.senderomapping.com` instead of GitHub's URL, create a CNAME at your DNS provider pointing to `allterracentralmgis.github.io`, then in repo Settings → Pages → Custom domain enter `salesmap.senderomapping.com`. Update the TomTom referrer allowlist (step 4) accordingly.
