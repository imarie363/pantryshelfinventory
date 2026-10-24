# Pantry Shelf

Scan QR labels on pantry items with your phone and see what to use first, sorted by expiry date.

- A small Node server (`server.js`) and a static web app (`public/`), with two libraries: `nodemailer` and `web-push`.
- Data is a few JSON files in a Docker volume (`/data`).
- A shared household password, plus an optional login for each person so the history shows who did what.
- Product barcode lookup through [Open Food Facts](https://world.openfoodfacts.org), a shared shopping list, recipe ideas from [TheMealDB](https://www.themealdb.com).
- Daily reminders by email and as phone notifications, a used vs. thrown away history, nightly backups with a weekly emailed copy, and restore from Settings.
- Installs on the home screen and still shows the shelf when you're offline.
- Reached from anywhere at your own domain through a Cloudflare Tunnel, with HTTPS. Phones only allow camera scanning on HTTPS sites.

## Set up on the Debian VM

These steps assume you can log in to the VM with `ssh` and use `sudo`.

### 1. Install Docker

```sh
sudo apt update && sudo apt install -y ca-certificates curl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # then log out and back in
docker compose version          # should print a version
```

### 2. Copy this folder to the VM

From the computer that has the folder:

```sh
scp -r pantry-shelf  you@<vm-ip>:~/
```

### 3. Create the Cloudflare Tunnel

1. Open the Cloudflare dashboard and go to **Zero Trust > Networks > Tunnels**, then **Create a tunnel**.
2. Choose **Cloudflared**, and name it `pantry`.
3. On the install screen, pick **Docker**. Copy the long token after `--token` from the command it shows. You don't need to run that command.
4. Under **Routes**, click **Add route** and choose **Published application** (older screens: the **Public hostname** tab). Set:
   - Subdomain: `pantry` (or anything you like)
   - Domain: your domain
   - Service URL: `http://app:3000`
5. Save the tunnel. Cloudflare creates the DNS record for you.

### 4. Fill in the settings

```sh
cd ~/pantry-shelf
cp .env.example .env
openssl rand -hex 32            # copy this into SESSION_SECRET
nano .env                       # set PANTRY_PASSWORD, SESSION_SECRET, TUNNEL_TOKEN
```

### 5. Start it

```sh
docker compose up -d --build
docker compose logs -f          # Ctrl+C to stop watching
```

The tunnel's status in Cloudflare should turn **Healthy**. Open `https://pantry.<your-domain>` on your phone and log in. To get an app icon, use **Add to Home Screen** (Safari: Share button; Chrome: ⋮ menu).

## Everyday use

- **Add item:** name, quantity, where it's stored, best-before date. Tap **Scan barcode** to fill in the name from the product's barcode. Every item gets a QR label: download it, print it, stick it on.
- **Scan:** a pantry label or a product barcode, with the in-app scanner. The phone's own camera app also opens labels directly.
- **Blank labels:** download a sheet of 24 blank labels, stick them on containers, and fill in the item the first time you scan one.
- **Read the date with the camera:** under the date field, take a close photo of the printed best-before date and the app fills it in (THT 12.05.2027, 03-11-26, 15 MEI 2027, 08/2027…). When the pack shows more than one date, tap the right one. Typing or picking the date works as before. The photo is read on your server (Tesseract) and not kept.
- **Same item, different dates:** one item can hold several best-before dates, say 2 cans for November and 3 for March. In the add form tap **+ Same item with another date**, or open the item and tap **Add another date**. The shelf shows the earliest date; **Used one** takes from the oldest batch first; reminders and reports list each date on its own line.
- **Household supplies:** toilet paper, detergent and other non-food things. Pick **Household supply** when adding; they need no best-before date. Set **Running low at** (default 1): when **Used one** brings it down to that many, it goes on the shopping list and into the reminder. Switch the shelf between **Food** and **Household** with the buttons at the top.
- **Where it's kept:** the chips above the shelf (All, Pantry, Fridge, Freezer…) show one place at a time. The phone remembers your choice.
- **Used one / Finished:** **Used one** takes one off the count. **Finished** asks whether you used it or threw it away, so the History tab can count it.
- **Shopping:** finished items go to the shopping list (untick the box to skip). Add your own items too, tick them off in the shop, then **Clear ticked items**.
- **History:** this month's used vs. thrown away, the last 6 months, what gets thrown away most, who did what, and recent activity.
- **Recipes:** ideas that use what expires first. Matching works on simple English names, like "rice" or "coconut milk".
- **Settings:** reminders, phone notifications, people, backups and restore, the cover photo, and this device.

## People

Under **Settings > People**, add a name and password for each person. The login screen then asks for a name; leaving the name empty still works with the household password. Tap a person's picture to give them a photo (cropped to a circle) or pick an emoji avatar; it shows in the header, the People list and the History tab. Anyone logged in can add or remove people and set a new password. Changing a password logs that person out on their other phones.

## Households for friends

One site can hold several households, each with its own shelf, shopping list, history, cover photo, reminders and people. Nobody sees another household's data.

- **Your household is the first one.** After the update, everything that was there stays as it was. The site's admins see **Settings > Site admin** and the email account that sends. Set `ADMINS` in `.env` to the login names that may do that (for example `ADMINS=Ima`); without it, everyone in the first household is an admin, and so is the household password login.
- **Inviting a friend:** in **Site admin**, tap **Make an invite code** and send it (the **Share** button sends a link that fills the code in). Each code works once, for 14 days. Your friend opens the site, taps **Create a household**, and picks a household name, their name and a password. They then add the people they live with under **Settings > People**.
- **Limits:** up to 10 households of up to 5 people each. Change them with `MAX_HOUSEHOLDS` and `MAX_MEMBERS` in `.env`. With `OPEN_SIGNUP=true`, anyone can create a household without a code until the site is full.
- **Names are unique on the whole site**, because the login asks for a name. If a name is taken, add a letter, like "Ana S".
- **Email:** the site sends every household's emails with one account (your Gmail), set by an admin in **Settings > Reminders**. Each household only fills in who gets them.
- **Removing:** an admin can delete another household in **Site admin**, and each household can delete itself under **Settings > Household**. Its last state is kept as a backup in `/srv/pantry-backups` until backups that old are cleaned up.
- The household password from `.env` keeps working, for the first household only.

## Phone notifications

Open **Settings > Phone notifications** on each phone and tap **Turn on for this phone**. The daily reminder then pops up there at the reminder time, next to (or instead of) the email.

- Android: works in Chrome straight away.
- iPhone (iOS 16.4 or newer): add the app to the home screen first, open it from the home screen icon, then turn notifications on. **Settings > This device** shows the home-screen steps for the browser you're using.

The server makes its own notification keys the first time and keeps them in the data volume (`vapid.json`).

## Email reminders (Gmail)

Set them up in the app: **Settings > Reminders**. You choose on/off, how often (every day, once a week on a chosen day, or once a month on a chosen date), the time, how many days ahead to look, and who gets the email. Admins also set the Gmail account that sends the emails for every household. Changes apply straight away, without a redeploy.

The reminder email looks like the weekly report: what to use first within the look-ahead days (pick 30 days to see a month ahead), what's running low, and the shopping list, with the full report attached as a PDF.

**Time zone:** reminder, report and backup times are local times in the site's time zone. An admin picks it in **Settings > Site admin > Time zone**. Without that it uses `TZ` from `.env`, and Europe/Amsterdam when `TZ` is empty or `UTC`.

1. Turn on 2-Step Verification at https://myaccount.google.com/security.
2. Create an app password at https://myaccount.google.com/apppasswords (name it `Pantry Shelf`).
3. In the app, fill in **Send to**, **Gmail address** and **App password**, tap **Save**, then **Send a test email**.

The settings are stored in the app's data volume (`settings.json` per household, the sending account in `site.json`). Any `SMTP_*`, `MAIL_TO` or `REMINDER_*` values in `.env` are only used as starting values until you save in the app. No email is sent on days when nothing is due.

## Backups

Every night at `BACKUP_TIME` the app saves everything (items, shopping list, remembered barcodes, history) to `/srv/pantry-backups/pantry-YYYY-MM-DD.json` on the VM and deletes copies older than `BACKUP_KEEP_DAYS`. Logins and passwords are not part of backups. The folder must belong to user id 1000:

```sh
mkdir -p /srv/pantry-backups && chown 1000:1000 /srv/pantry-backups
```

**Weekly report:** every household has **Settings > Weekly report**. **Email it to me now** sends the report to the household's reminder email addresses, and **Email the report every week** sends it on the day and time they pick. The email shows what to use first, this month's used vs. thrown away, what's on the shelf and the shopping list, with a PDF of the same report attached. For the first household (the admin's) the backup file is attached too, so a copy is kept off the server. **See this week's report (PDF)** shows the report any time.

**Backups card:** only admins see **Settings > Backups** (back up now, download, restore). The backup routes answer 403 for everyone else; friends' households are still backed up every night on the server.

**Restore:** **Settings > Backups > Restore a backup** (admins) puts back one of the saved backups, or a file you upload (for example from that email). What's there before the restore is saved first as `pantry-before-restore-….json`, so a restore can be undone the same way.

**A second machine:** to keep a ready copy of the app on another VM that can take over within minutes, plus a nightly backup of the whole VM in Proxmox, see [docs/high-availability.md](docs/high-availability.md).

## Updating

### Automatically from GitHub

If the folder on the server is a clone of this repository, `scripts/auto-update.sh` checks GitHub for new commits on `main` and rebuilds the app when there are any. Run it every 15 minutes with cron:

```sh
crontab -e
# add this line:
*/15 * * * * /pantry/pantry-shelf/scripts/auto-update.sh >> /var/log/pantry-update.log 2>&1
```

To turn a copied folder into a clone without losing anything (`.env` and the data volume are not touched; keep the folder name `pantry-shelf`, since Docker names the data volume after it):

```sh
cd /pantry/pantry-shelf
git init -b main
git remote add origin https://github.com/<you>/<repo>.git
git fetch origin main
git reset --hard origin/main
chmod +x scripts/auto-update.sh
```

### By hand

```sh
git pull
docker compose up -d --build
```

## Optional: an extra Cloudflare login

For a stronger lock than the shared password, add a **Zero Trust > Access > Application** for the same hostname, allowing only your household's email addresses. Cloudflare then asks for a one-time email code before the app opens.

## Run without Docker (for testing)

```sh
PANTRY_PASSWORD=test node server.js     # Node 20 or newer; open http://localhost:3000
```
