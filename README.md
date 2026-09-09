# Local Rank Checker (Chrome Extension)

A local-only Chrome Extension (Manifest V3) designed for SEO agencies to automate Monday morning keyword ranking checks on Google. 

Compares current Google organic rankings against previous positions, identifies exact landing page vs. domain matches, and exports results directly into Excel.

---

## 1. How to Install Locally

1. Open **Google Chrome**.
2. Navigate to `chrome://extensions` in the address bar.
3. In the top right corner, toggle **Developer mode** to **ON**.
4. Click the **Load unpacked** button in the top left.
5. In the file picker, select the project directory:
   ```
   D:\EXTEN
   ```
6. Click **Select Folder**.
7. In Chrome's toolbar, click the Puzzle icon (Extensions) and **Pin** "Local Rank Checker" for quick access.

---

## 2. How to Test (5-Keyword Sample)

Paste the following 5 rows directly into the **Keyword Data** textarea in the extension popup.

> **Note:** These are real test examples using well-known domains so you can immediately see exact page matches, domain matches, and rankings:

```text
wikipedia	https://www.wikipedia.org	1
github	https://github.com	1
python download	https://www.python.org/downloads	2
mozilla developer web docs	https://developer.mozilla.org	1
openai chatgpt	https://chatgpt.com	1
```

*(You can also replace these with your agency's actual clients and target landing pages).*

### Testing Steps:
1. Click the **Local Rank Checker** icon in your Chrome toolbar.
2. Paste the 5 rows above into the textarea.
3. Select your Google Domain (default: `google.com`).
4. Set Delay (default is `8` seconds, minimum is `5` seconds).
5. Click **START**.
6. Observe:
   - A normal, visible Google search tab opens.
   - The extension searches the first keyword, parses organic results, and compares URLs.
   - The result appears in the table with current rank, change (`↑`, `↓`, `—`), and match status.
   - The extension pauses for the configured delay before running the next keyword.
   - When finished, click **COPY RESULTS** and paste directly into Excel to verify the tab-separated format, or click **DOWNLOAD CSV**.

---

## 3. Controls & Features

- **START**: Validates input format and begins sequential processing.
- **PAUSE**: Halts between searches and holds queue position.
- **RESUME**: Continues rank checking from the paused keyword.
- **STOP**: Safely stops the queue and preserves already completed results for export.
- **CLEAR**: Resets input, queue, and completed results after user confirmation.
- **COPY RESULTS**: Copies tab-separated values (TSV) directly to clipboard for pasting into Excel columns.
- **DOWNLOAD CSV**: Downloads a `.csv` file of all parsed results.

---

## 4. Google Automation Safety & Interruption Handling

- Operates in normal visible tabs at human-like intervals (minimum 5s, default 8s delay).
- Does **not** bypass CAPTCHAs, use proxies, spoof fingerprints, or scrape secretly.
- If Google presents a CAPTCHA or "unusual traffic" challenge:
  - The job will immediately pause with the message:  
    `"Google interrupted rank checking. The job has been paused."`
  - The Google tab remains open so you can solve it manually.
  - After solving the challenge in the tab, click **RESUME** in the extension to continue.

---

---

## 5. Milestone 2: Browser Geolocation Simulation (`chrome.debugger`)

Allows SEO professionals to simulate geographic coordinates (Latitude, Longitude, Accuracy) on the visible Google Search tab without using external proxies or third-party paid APIs.

### Why the `"debugger"` permission is required:
The extension Manifest includes the `"debugger"` permission:
> *"It is used only to apply a user-selected browser geolocation override to the visible Google Search tab."*

- The Chrome DevTools Protocol (CDP) method `Emulation.setGeolocationOverride` requires debugger attachment.
- The session is strictly scoped to the single visible Google Search tab (`searchTabId`).
- It does **not** inspect other tabs, read network traffic, collect cookies, or transmit data externally. Everything remains local.

### How to Use Location Simulation:
1. In the extension popup, check **Use Location Simulation**.
2. Enter the target **Latitude** (e.g. `40.7128`) and **Longitude** (e.g. `-74.0060`).
3. (Optional) Enter a **Location Name** (e.g. `New York Client`) and **Accuracy** (default: `20` meters).
4. Click **APPLY LOCATION** to configure or activate the override.
5. Click **TEST LOCATION** to verify that the browser's geolocation API in a search tab reports the simulated coordinates.
6. Click **START** to run rank checking under the active simulated location.
7. Click **RESET LOCATION** at any time to clear the override and detach the debugger session.

### Known Limitations:
- **Browser Geolocation Override vs. IP**: The override alters device/browser geolocation (`navigator.geolocation`). It does **not** alter public IP address, ISP, or VPN routing.
- Google combines multiple signals (including IP subnet, Google Account history, and language preferences) to infer user location. The extension displays `Browser Location Override: ACTIVE`, but does not guarantee exact Google SERP localized results for IP-restricted queries.

---

## 6. How to Debug / Inspect

If something does not appear as expected, inspect the relevant component:

1. **Extension Popup Console**:
   - Click the extension icon to open the popup.
   - Right-click anywhere in the popup window and click **Inspect**.
   - Check the **Console** tab for popup and validation logs.

2. **Background Service Worker**:
   - Go to `chrome://extensions`.
   - Find **Local Rank Checker**.
   - Click the blue link: **service worker** (Inspect views: service worker).
   - In the DevTools window that opens, view the **Console** tab for background queue, CDP attachment, and navigation logs.

3. **Google Search Page Content Script**:
   - While a Google search tab is open during checking, press `F12` (or right-click → **Inspect**).
   - In the **Console** tab, inspect DOM and SERP parsing logs.
