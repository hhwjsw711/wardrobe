# Use Wardrobe privately on your computer and phone

The Mac is the home for the app, photos, API key, and `data/library.json`. Tailscale gives your phone an encrypted HTTPS route back to the Mac. Nothing is deployed to a public website.

```text
iPhone  ── private Tailscale connection ──▶  Wardrobe on this Mac  ──▶  local data/
Mac browser ──────────────────────────────▶  127.0.0.1:4173
```

The Mac must be on and connected for imports or edits. The phone keeps a read-only saved copy of previously viewed pieces when the Mac is unavailable.

## 1. Set up Wardrobe on the Mac

From this repository:

```bash
npm install
cp .env.example .env
```

Add an OpenAI API key to `.env`. The first time you open the importer, choose up to five clear photos of yourself from the phone or computer. A full-body photo, a clear face, and another angle give the styling model better identity and proportion context. Wardrobe converts and saves these under `data/model-references/` for modeled previews; an existing `data/model-reference.png` is also included. Both `.env` and the entire `data/` directory are ignored by Git and stay on this Mac.

The selected source photos and the model reference are sent to the OpenAI API when you ask the importer to analyze, extract, or model clothing. They are not served as a public website; the local database and generated library remain in `data/`.

When you select clothing photos, Wardrobe first saves them to the Mac and then processes at most two API jobs at once. New phone uploads automatically proceed through detection, web-grounded product identification, garment extraction, modeled-image generation, and local library import. Exact names are used only when the photo and a sourced product page agree; possible or unknown matches stay labeled conservatively. Each accepted product source is shown as a clickable link in the item editor. Once the bottom tray says the photos are queued on the computer, you can switch apps or lock the phone. Reopening Wardrobe shows the current queued, processing, failed, and ready-for-review states. Interrupted client submissions retry automatically, unfinished Mac-side jobs resume when the Wardrobe service restarts, and only items that need attention stop for review.

Start the private app:

```bash
npm run personal
```

Keep that terminal open. On the Mac, the app is available at [http://127.0.0.1:4173](http://127.0.0.1:4173).

### Optional: start Wardrobe automatically at login

Stop the terminal process above, then run:

```bash
npm run personal:install
```

This creates the macOS login service `dev.wardrobe.personal`. Its logs are in `~/Library/Logs/Wardrobe.log` and `~/Library/Logs/Wardrobe.error.log`.

To remove the login service without touching any wardrobe data:

```bash
npm run personal:uninstall
```

Run `npm run personal:install` again after pulling or making code changes; it rebuilds the app before restarting the service.

## 2. Create the private phone connection

1. Install Tailscale on the Mac and phone, then sign in to both with the same account.
2. On the Mac, expose only the local Wardrobe port to your Tailscale network:

   ```bash
   tailscale serve --bg http://127.0.0.1:4173
   tailscale serve status
   ```

3. `tailscale serve status` prints a private URL similar to `https://your-mac.your-tailnet.ts.net`. Open it in Safari on the phone while Tailscale is connected.

Use `tailscale serve`, never `tailscale funnel`: Serve is limited to your Tailscale network, while Funnel intentionally publishes a service to the internet. The `--bg` configuration survives Tailscale and computer restarts.

## 3. Put it on the phone’s Home Screen

In Safari, open the private `https://…ts.net` URL, tap Share, choose **Add to Home Screen**, keep **Open as Web App** enabled, and tap **Add**.

On the first visit, use **Choose styling photos** to add one to five private reference images used together for modeled previews. After setup, the person-shaped button beside **Add clothes** adds more styling photos until five are saved. **Add clothes** can choose clothing photos from the camera roll or open the camera. Imports, product matches, metadata edits, and deletes all save to the same `data/library.json`, so the phone and Mac show the same collection. Open any existing piece and tap **Identify product** to search for its exact product using the best retained source image available.

## Back up the wardrobe

Back up the whole ignored `data/` directory to an encrypted personal backup. It contains the database, retained source crops, original import jobs, generated garment images, and the local identity references. Do not commit it to Git.

## If something is not working

- **The phone shows “Saved copy”:** confirm the Mac is awake, the Wardrobe service is running, and Tailscale is connected on both devices.
- **The phone cannot open the URL:** run `tailscale serve status` on the Mac and use the HTTPS URL it prints.
- **Imports say computer setup is needed:** check `OPENAI_API_KEY` in `.env`, then restart the Wardrobe service. Missing styling photos can be added directly from the phone.
- **Port 4173 is already in use:** stop any other `npm run personal` or `npm run dev` process before starting the login service.
