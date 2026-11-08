# Deploying rivals.io

```
Players ──https──▶ Vercel (client: lobby + game page)
   │
   └──wss──▶ Fly.io (game server: Colyseus, 1 machine, Singapore)
```

- **Client** → Vercel (static site, free)
- **Game server** → Fly.io (one small machine that sleeps when nobody is connected)

Deploy the server first: the client needs its address.

---

## 1. Game server on Fly.io

### Install the Fly CLI (Windows PowerShell)
```powershell
iwr https://fly.io/install.ps1 -useb | iex
```
Close and reopen PowerShell, then sign in (opens the browser; a card is required):
```powershell
fly auth login
```

### First deploy
From the project folder (`c:\laragon\www\rivals.io`):
```powershell
fly launch --copy-config --no-deploy
```
- It reads the included `fly.toml` (Singapore, 512 MB, sleep when idle).
- If it says the app name is taken, edit `app = "…"` in `fly.toml` to something unique (e.g. `rivals-io-jude`) and run it again.
- Answer **No** if it offers to set up databases (Postgres, Redis, etc.). The game doesn't need any.

Then deploy (Fly builds the Docker image on its own servers, no Docker needed on your PC):
```powershell
fly deploy
```

### Make sure exactly ONE machine runs ⚠️
Game rooms live in that machine's memory. Fly creates 2 machines by default, so scale to 1:
```powershell
fly scale count 1
```

### Check it
```powershell
fly status        # should show 1 machine
fly logs          # live server logs (Ctrl+C to stop watching)
```
Your server address is **`wss://<app-name>.fly.dev`** (e.g. `wss://rivals-io-game.fly.dev`).

### Update the server later
After changing server code: `fly deploy` (it keeps 1 machine).

---

## 2. Client on Vercel

1. Go to **vercel.com** → **Add New… → Project** → import the GitHub repo `rivals.io`.
2. **Root Directory:** leave it as the repo root (`./`). The included `vercel.json` already sets the install/build commands and the `client/dist` output.
3. **Environment Variables:** add
   - Name: `VITE_SERVER_URL`
   - Value: `wss://<app-name>.fly.dev`
4. Click **Deploy**.

Every push to `main` redeploys the client automatically.
If you change `VITE_SERVER_URL` later, redeploy (Deployments → ⋯ → Redeploy): it's baked in at build time.

---

## 3. Test

Open your Vercel URL (e.g. `https://rivals-io.vercel.app`). The lobby should show **Live**. Open it on two devices or windows and play.

The first visit after a quiet period may take a few seconds while the Fly machine wakes up.

---

## Costs

- **Vercel:** free (Hobby plan).
- **Fly.io:** pay-as-you-go. One `shared-cpu-1x` / 512 MB machine that sleeps when idle costs roughly a few dollars a month at most; check fly.io/pricing. Set a spending alert in the Fly dashboard if you like.

## Troubleshooting

| Problem | Fix |
|---|---|
| Lobby says **Offline** | Check `VITE_SERVER_URL` in Vercel starts with `wss://` and matches your Fly app name, then redeploy. Check `fly status` / `fly logs`. |
| Players in the same room can't see each other | More than one machine is running: `fly scale count 1`. |
| `fly deploy` fails on the app name | Change `app` in `fly.toml` to a unique name. |
| Server out of memory in `fly logs` | `fly scale memory 1024` |

Never set `TEST_HOOKS=1` on the deployed server (it enables a teleport command meant for automated tests).
