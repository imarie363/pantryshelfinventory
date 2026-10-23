# Warm standby and backups

This keeps a second, ready copy of Pantry Shelf on another VM, so the app can come back within a few minutes if homelab-main breaks.

- **homelab-main** serves the app as usual.
- **The standby VM** (for example one of your RHEL VMs) copies the data, the settings and the nightly backups from homelab-main every 5 minutes. Its copy of the app stays stopped.
- **If homelab-main goes down**, one command on the standby starts the app and the Cloudflare tunnel there. pantry.bahaykubo-lab.com then works again, with at most about 5 minutes of changes missing.
- **When homelab-main comes back**, the standby stops it automatically within a minute, so the two never both take changes. Another command moves everything back.
- **Proxmox** also saves the whole homelab-main VM every night.

Only one machine serves at a time. The app keeps its data in files, so two running copies would each end up with a different shelf.

Logins, phone notifications, avatars and the cover photo all carry over, because they live in the data that's copied.

## 1. Nightly VM backup in Proxmox

1. In the Proxmox web UI, go to **Datacenter > Backup > Add**.
2. **Storage:** pick a storage that isn't the disk homelab-main runs on, such as a NAS share or Proxmox Backup Server.
3. **Schedule:** `03:00`. **Selection mode:** Include selected VMs, and tick homelab-main.
4. **Mode:** Snapshot. On the **Retention** tab, keep for example the last 7 daily backups.
5. Click **Create**. To check it, select the job and click **Run now**.

To restore the whole VM, select the backup in the storage's **Backups** list and click **Restore**.

## 2. Before you start: homelab-main

homelab-main needs to be a clone of the GitHub repository and on the latest version. See *Updating > Automatically from GitHub* in the README. Then:

```sh
cd /pantry/pantry-shelf && scripts/auto-update.sh
```

## 3. Set up the standby VM

Run everything as root on the standby VM.

**Install Docker and git** (RHEL, Rocky or Alma):

```sh
dnf -y install dnf-plugins-core git
dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
dnf -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker
```

**Get the app.** Keep the folder name `pantry-shelf`, because Docker names the data volume after it:

```sh
mkdir -p /pantry && cd /pantry
git clone https://github.com/imarie363/pantryshelfinventory.git pantry-shelf
cd pantry-shelf
echo standby > .role            # this machine keeps the app stopped until a failover
mkdir -p /srv/pantry-backups && chown 1000:1000 /srv/pantry-backups
```

**Let the standby log in to homelab-main** with a key (press Enter at the questions; this asks for homelab-main's root password once):

```sh
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
ssh-copy-id root@192.168.178.92
ssh root@192.168.178.92 true && echo "SSH works"
```

**Settings for the scripts:**

```sh
cp scripts/ha/ha.conf.example scripts/ha/ha.conf
nano scripts/ha/ha.conf          # the defaults already match homelab-main
```

**First copy, and build the app** so a failover starts quickly:

```sh
scripts/ha/standby-sync.sh
scripts/ha/status.sh
docker compose build
```

`status.sh` should say `This machine: standby`, `Last copy: 0 min ago` and `homelab-main: reachable, serving`.

**Run it automatically.** Open `crontab -e` and add:

```
* * * * * /pantry/pantry-shelf/scripts/ha/standby-sync.sh >> /var/log/pantry-standby.log 2>&1
*/15 * * * * /pantry/pantry-shelf/scripts/auto-update.sh >> /var/log/pantry-update.log 2>&1
```

The first line runs every minute, but only copies every `SYNC_EVERY` seconds (5 minutes). The minute checks are what stop homelab-main quickly if it comes back during a failover. The second line keeps the standby's code up to date; on a standby it only builds the new version and doesn't start it.

The standby also keeps its own copy of the nightly backups in `/srv/pantry-backups` (90 days by default, `KEEP_DAYS`).

## When homelab-main is down

On the standby:

```sh
/pantry/pantry-shelf/scripts/ha/failover.sh
```

It stops the app on homelab-main if it can still reach it, takes one last copy, and starts the app and the tunnel on the standby. Cloudflare sends visitors to the standby within a minute; nothing changes in DNS or Cloudflare.

You can also use this for planned maintenance on homelab-main. With homelab-main reachable, nothing is lost.

## Moving back to homelab-main

Once homelab-main runs again (it is kept stopped automatically), on the standby:

```sh
/pantry/pantry-shelf/scripts/ha/failback.sh
```

It stops the standby, copies everything that changed meanwhile (including new nightly backups) to homelab-main, and starts it there. If anything goes wrong on the way, the standby keeps serving and nothing on homelab-main is overwritten until the copy has fully arrived.

## Checking

```sh
/pantry/pantry-shelf/scripts/ha/status.sh
tail /var/log/pantry-standby.log
```

The log only gets a line when something happens: a copy that failed, homelab-main being stopped, a failover or failback.

## Things to know

- Don't start the app by hand with `docker compose up` on the standby while homelab-main serves. Use `failover.sh`, so the roles stay right.
- If homelab-main restarts during a failover, its app and tunnel may serve for up to a minute before the standby stops them. Changes made in that minute on homelab-main are lost at failback.
- The `.role` file in the app folder says which machine serves: `standby` means stopped, no file means serving. The scripts manage it.
