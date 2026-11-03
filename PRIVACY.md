# Privacy Policy & Data Handling

UnRepost is designed with a **privacy-first, local-only architecture**. It is 100% free open-source software with no external servers, no tracking, and no commercial interests.

---

## 🔒 1. Core Privacy Guarantees

* **No Cloud Servers or Telemetry:** UnRepost does not send data, telemetry, analytics, or error reports to the project maintainers, developers, or any third party.
* **No Password Access:** You log into TikTok directly via a genuine browser window. UnRepost never requests, inspects, intercepts, or stores your password or multi-factor authentication credentials.
* **Local Execution Only:** The control dashboard and automation engine execute entirely on your own computer (`127.0.0.1`).

---

## 💾 2. What Data Is Stored Locally

All user data is stored strictly on your local filesystem in your operating system's standard Application Support folder:
* **macOS:** `~/Library/Application Support/UnRepost/`
* **Windows:** `%APPDATA%/UnRepost/`
* **Linux:** `~/.config/unrepost/`

Data stored consists of:
1. **Browser Session Profile (`tiktok_session_data/`):** Contains your active TikTok web cookies (such as `sessionid`, `msToken`, and `tt_csrf_token`). These allow the tool to perform un-repost actions on your behalf without re-asking for login. Permissions are set to user-only (`chmod 700`).
2. **State & Progress File (`unrepost_state.json`):** Tracks which video IDs have been confirmed as un-reposted, skipped IDs (e.g. original videos deleted by their creator), and your pacing preferences. This file prevents the tool from repeating already-processed videos if restarted.

---

## 🌐 3. Network Connections Made

UnRepost initiates network connections **exclusively** to the following destinations:
1. **Loopback (`127.0.0.1:3210`):** Communication between the local backend engine and the local browser dashboard. All incoming requests are verified with loopback and origin checks to prevent cross-site request forgery (CSRF) from external websites.
2. **Official TikTok Endpoints (`https://www.tiktok.com`):**
   * `https://www.tiktok.com/api/repost/item_list/` (Retrieves your paginated list of reposts)
   * `https://www.tiktok.com/tiktok/v1/upvote/delete` (Sends the internal un-repost command)
   * `https://fonts.googleapis.com` (Static font assets loaded by the dashboard UI)

UnRepost makes **zero** other outgoing network requests.

---

## 🗑️ 4. How to Delete Your Data

You can completely remove your session and history at any time:
1. **Inside the App:** Click the **"Sign Out & Clear Session"** button in the dashboard. This securely closes the active browser context and purges the local session directory.
2. **Manual Cleanup:** Delete the application data directory from your computer:
   * **macOS:** `rm -rf ~/Library/Application\ Support/UnRepost`
   * **Windows:** Remove the `%APPDATA%\UnRepost` folder
   * **Linux:** `rm -rf ~/.config/unrepost`

---

## ⚠️ 5. Audit Log Export Warning

The dashboard provides options to download **CSV** or **JSON** audit logs of removed videos for your personal records. These files contain video IDs and timestamps associated with your account. Do not upload or share these audit logs publicly if you wish to keep your account activity anonymous.
