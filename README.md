# SERPTrack (Chrome Extension)

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
7. In Chrome's toolbar, click the Puzzle icon (Extensions) and **Pin** "SERPTrack" for quick access.

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
1. Click the **SERPTrack** icon in your Chrome toolbar.
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
4. Click **APPLY LOCATION** to open a dedicated Google search tab and verify its device-geolocation override.
5. Click **TEST LOCATION** to focus and verify that same Google tab again. The test tab stays open (until you close it or reset the override). If Chrome denies the request, open that tab's **Site settings → Location → Allow**, then retry. **Do not use Google's page-footer city as the test result**: that may be based on your IP address.
6. Click **START** to run rank checking under the active simulated location.
7. Click **RESET LOCATION** at any time to clear the override and detach the debugger session.

### Known Limitations:
- **Browser Geolocation Override vs. IP**: The override alters the *attached tab's* device/browser geolocation (`navigator.geolocation`) only. It does **not** alter public IP address, ISP, VPN routing, Google's footer location, or tabs elsewhere in Chrome.
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
   - Find **SERPTrack**.
   - Click the blue link: **service worker** (Inspect views: service worker).
   - In the DevTools window that opens, view the **Console** tab for background queue, CDP attachment, and navigation logs.

3. **Google Search Page Content Script**:
   - While a Google search tab is open during checking, press `F12` (or right-click → **Inspect**).
   - In the **Console** tab, inspect DOM and SERP parsing logs.


## Flexible keyword input and remembered device coordinates

- Paste TSV/CSV tables with **Keyword**, **Website/Target URL**, and optional **Previous Rank** headers in any order. Extra columns are ignored when recognized headers are supplied.
- For keyword-only lists, enter a **Default target website** in the dashboard or popup.
- Uploaded XLSX workbooks can have different worksheet names and header mappings; use manual mapping when automatic detection is not suitable.
- Valid latitude/longitude/accuracy pairs are retained in `chrome.storage.local` **on this device only** so they survive popup/dashboard switches and browser restarts. The latest pair is a convenient default, **not an automatically enabled client location**.
- Click **Reset Location** to delete remembered coordinates. **Clear Session Data does not delete that saved device coordinate pair**. Other sensitive client data remains in `chrome.storage.session`; the original workbook remains only in dashboard memory.
- Chrome's device-geolocation override cannot change an IP address or guarantee Google's actual geographic ranking location.


## Organic ranking position methodology (strict-organic-web-v2)

SERPTrack reports **organic web listing position**, **not** Google Search Console
"average position", "All" surface placement, AI citation position, Maps ranking,
or universal/paid placement.

- **Count**: one regular standalone organic website result per visible main
  listing, in DOM order. A standalone featured snippet with a conventional
  primary website result link counts as one listing. A standalone YouTube
  result may count as an organic web listing, but a video carousel does not.
- **Exclude**: AI Overviews and their citations, AI-generated summaries,
  sponsored ads, shopping/product cards, map/local packs, People Also Ask,
  knowledge panels, Top Stories and news/video/image carousels,
  discussions/forum packs, related searches, sitelinks and secondary cards.
- **Pagination**: continue the sequence of extracted organic listings; a URL
  repeated as an independent listing on another Google page still consumes
  a listing position. If Google ignores pagination and returns only already
  visited URLs, the rank check reports ERROR instead of inventing positions.
- **Uncertainty**: changes to Google's DOM, ambiguous result grouping,
  personalization and geographic targeting can affect observed positions.
  When no trustworthy organic listings can be extracted, report ERROR
  rather than treating the target as unranked. Compare against the
  standalone organic web listings you can see, **not** all visible cards.

Use the Chrome extension's debug mode on an actual Google SERP and review
`window.LOCAL_RANK_DEBUG` to see the parsed organic URLs in order, together
with skipped-feature and secondary-heading counts. The parser uses structural
selectors which can change as Google updates its search UI; synthetic tests
do not establish accuracy on every live query or country.


### Diagnosing an incorrect Organic Rank (v1.0.2)

After running a keyword, open the **Dashboard → Results** table and click **Audit**
under that row's Organic Rank. The modal lists the exact organic URLs the
extension counted in sequence. Compare this list against Google's *same*
results tab, country domain, keyword and search session.

In v1.0.2, the parser handles `#center_col` layouts when `#rso` and
`#search` are missing or only hold AI content, ignores hidden result headings,
and filters additional AI Overview containers. Unrecognized layouts may still
require updating the parser, and an inconclusive extraction is reported as
ERROR rather than an invented organic position. A Google position also varies
by IP, language, device, account, and time: device-coordinate simulation
alone cannot guarantee geographically identical SERPs.
