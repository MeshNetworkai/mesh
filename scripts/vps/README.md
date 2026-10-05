# Putting Mesh on the server (one-time setup)

You do this once. Afterwards **every push to `main` on GitHub deploys itself**; nobody needs to log in
to the server again.

What you need on your Mac:

- the server's SSH key file at `~/Documents/mesh-keys/mesh_deploy` (the one that lets `root` in)
- this repository checked out at `~/Documents/mesh`
- the server IP: **80.78.27.94**

The domain is optional for now. Without it the site runs on plain `http://80.78.27.94`; once you have
bought one, see "After you buy the domain" at the bottom (two minutes, nothing is lost).

---

## Step 1 - run the bootstrap (about 5 minutes)

Open **Terminal** on the Mac and paste this as one line. Replace `DOMAIN` with your domain
(for example `meshnetwork.ai`), or delete `--domain DOMAIN` entirely if you do not have one yet:

```sh
ssh -i ~/Documents/mesh-keys/mesh_deploy root@80.78.27.94 'bash -s' -- --domain DOMAIN < ~/Documents/mesh/scripts/vps/bootstrap.sh
```

It installs everything (firewall, Docker, Caddy for HTTPS, a `mesh` user, backups) and finishes with a
green **"Bootstrap complete"** banner followed by:

1. an **ADMIN_TOKEN** - copy it into your password manager now, it is shown only this once;
2. a **deploy key** - one long line starting with `ssh-ed25519`;
3. a **NEXT STEPS** list (the same as steps 2-4 below).

If the first `ssh` asks "Are you sure you want to continue connecting?", type `yes`.
Running it again later is safe: it keeps the secrets and only updates what changed.

> If you use Cloudflare in front of the domain (orange cloud), add `--cloudflare` to the command so the
> country header Cloudflare sends is kept.

## Step 2 - give the server read access to the code (deploy key)

The repository is private, so the server needs its own key to download the code.

1. On GitHub open the repo **MeshNetworkai/mesh** -> **Settings** -> **Deploy keys** -> **Add deploy key**.
2. Title: `mesh-vps 80.78.27.94`
3. Key: paste the `ssh-ed25519 ...` line the bootstrap printed.
4. Leave **Allow write access** unchecked. Click **Add key**.

## Step 3 - give GitHub the key to log in to the server (two secrets)

GitHub's robot deploys by logging in to the server as `mesh` with the same key you used in step 1.

1. In the repo: **Settings** -> **Secrets and variables** -> **Actions** -> **New repository secret**.
2. Add **`VPS_HOST`** with value `80.78.27.94`.
3. Add **`VPS_SSH_KEY`** with the *contents* of the key file. To copy it to the clipboard, run in Terminal:

   ```sh
   cat ~/Documents/mesh-keys/mesh_deploy | pbcopy
   ```

   then paste into the Value box (it must start with `-----BEGIN` and end with `-----END ... KEY-----`).

That's it. (`VPS_USER` is optional; it defaults to `mesh`.)

## Step 4 - DNS (skip if you have no domain yet)

At your domain provider, create these records, all pointing at the server:

| Type | Name  | Value              |
| ---- | ----- | ------------------ |
| A    | `@`   | `80.78.27.94`      |
| A    | `api` | `80.78.27.94`      |
| A    | `www` | `80.78.27.94`      |
| AAAA | `@`, `api`, `www` (optional) | `2a0a:3840:8078:27::504e:1b5e:1337` |

If the domain is on **Cloudflare**: keep the orange cloud (proxied) on, and set
**SSL/TLS -> Overview -> Full (strict)**. Add `--cloudflare` when you run the bootstrap (step 1).

HTTPS certificates are issued automatically a minute or two after the records go live. Nothing to do.

## Step 5 - the first deploy

GitHub -> repo -> **Actions** tab -> **Deploy** (left side) -> **Run workflow** -> leave `deploy`
selected -> **Run workflow**. Watch the log; it ends with a health check. 3-6 minutes the first time.

From now on every push to `main` does the same thing automatically. The same **Run workflow** button
also offers `restart`, `logs` (last 200 lines of the gateway), `health` and `backup`.

Check it worked:

- `https://api.DOMAIN/health` (or `http://80.78.27.94/health` without a domain) shows `"ok": true`
- `https://DOMAIN` (or `http://80.78.27.94`) shows the web app

---

## After you buy the domain

Run step 1 again with the domain, then do step 4 (DNS) and step 5 (Run workflow -> deploy):

```sh
ssh -i ~/Documents/mesh-keys/mesh_deploy root@80.78.27.94 'bash -s' -- --domain DOMAIN < ~/Documents/mesh/scripts/vps/bootstrap.sh
```

Secrets, data and the deploy key stay exactly as they were; only the web addresses change.
The deploy afterwards is needed because the web app is built with the API address baked in.

## Good to know

- **Backups**: the database is copied every night (03:15 UTC) to `/opt/mesh/backups` on the server,
  newest 14 kept, and once more right before each deploy.
- **Secrets on the server** live in `/opt/mesh/.env` (only root and `mesh` can read it). To add an
  OpenRouter key later, someone with the root key edits that file and runs the `restart` workflow.
- **Admin endpoints** (`/admin/...`) are deliberately not reachable from the internet; they only
  answer on the server itself.
- Sign-in with a wallet needs HTTPS, so it only works once a domain is set up.
- The manual, step-by-step version of all this is in `scripts/deploy-vps.md`.
