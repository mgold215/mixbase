# mixBase — App Store Submission Checklist

Work through this top-to-bottom. Items marked **[YOU]** require action on your Apple account or physical device. Items marked **[DONE]** are already handled in the codebase.

---

## 1. Apple Developer Account

- [ ] **[YOU]** Enroll at https://developer.apple.com/programs/ ($99/year)
- [ ] **[YOU]** Accept latest Apple Developer Program License Agreement in App Store Connect
- [ ] **[YOU]** Verify your legal entity name and bank/tax information in App Store Connect → Agreements, Tax, and Banking

---

## 2. App ID & Capabilities

- [ ] **[YOU]** In Certificates, Identifiers & Profiles → Identifiers, register:
  - **Bundle ID:** `com.moodmixformat.mixbase` (Explicit)
  - Enable capability: **Background Modes → Audio, AirPlay, and Picture in Picture**
  - Enable capability: **Push Notifications** (optional, for future use)

---

## 3. Signing & Certificates

- [ ] **[YOU]** In Xcode → Signing & Capabilities, enable "Automatically manage signing"
- [ ] **[YOU]** Select your Team (requires Apple Developer account logged in)
- [ ] **[YOU]** Xcode will auto-create: Distribution Certificate + App Store Provisioning Profile

---

## 4. App Icon

The Xcode project expects a single **1024×1024 PNG** (no alpha, no rounded corners — Apple adds the mask).

- [ ] **[YOU]** Design or commission a 1024×1024 icon PNG

**Icon brief:** Dark background (#0d0b08 warm black), teal accent (#2dd4bf), minimal — a waveform or stacked lines suggesting music versions. The word "mB" or a stylised "m" works well. Keep it legible at 60×60 (iPhone home screen size).

- [ ] **[YOU]** Open `ios/mixBase/Assets.xcassets/AppIcon.appiconset/` in Xcode and drag your PNG into the 1024×1024 slot
- [ ] **[YOU]** Update `Contents.json` to reference your file:
  ```json
  {
    "images": [
      {
        "filename": "AppIcon-1024.png",
        "idiom": "universal",
        "platform": "ios",
        "size": "1024x1024"
      }
    ],
    "info": { "author": "xcode", "version": 1 }
  }
  ```

**Quick option:** Use the AI artwork generator in the app itself — generate something at 1024×1024 and export it. Flux 2 Pro works well for abstract / dark minimalist art.

---

## 5. Screenshots

Apple requires screenshots for at least two device sizes. Easiest path: use the iOS Simulator in Xcode.

### Required sizes
| Slot | Device | Resolution |
|---|---|---|
| **6.9" (required)** | iPhone 16 Pro Max | 1320×2868 pt → 1320×2868px @ 3x |
| **6.5" (required)** | iPhone 11 Pro Max / 15 Plus | 1242×2688 px |
| **5.5" (optional)** | iPhone 8 Plus | 1242×2208 px |
| **12.9" iPad (if supporting iPad)** | iPad Pro 6th gen | 2048×2732 px |

### What to capture (6 screenshots recommended)

1. **Dashboard** — Show 4–6 projects with artwork, status badges, version counts. Caption idea: *"All your music, one place"*
2. **Project detail** — A project open with 3+ versions, waveform player visible. Caption: *"Every version, every bounce"*
3. **Player** — Full-screen player with album art backdrop, waveform, controls. Caption: *"Immersive playback"*
4. **Share / Feedback** — The share page open in Safari (or the feedback view in-app). Caption: *"Share for feedback — no account needed"*
5. **Pipeline** — Release checklist with several items checked. Caption: *"From rough to released"*
6. **AI Artwork** — Artwork generation screen showing generated options. Caption: *"AI cover art in seconds"*

### Capture steps
```
1. Open Xcode → Product → Destination → iPhone 16 Pro Max Simulator
2. Run the app (⌘R)
3. Navigate to each screen
4. macOS: ⌘+Shift+4 then Space, click the simulator window
   OR in Simulator menu: File → Save Screen
5. Repeat for each screenshot
```

### Adding captions (optional but recommended)
Use Figma, Sketch, or Canva to add text overlays on the dark (#0d0b08) background with teal (#2dd4bf) accent text. Font: Bebas Neue for headlines, Jost for body — matching the app's design system.

---

## 6. Privacy Manifest (iOS 17+)

Apple requires a `PrivacyInfo.xcprivacy` file for any app using certain APIs.

- [ ] **[YOU]** In Xcode, add a new file: File → New → File → Privacy Manifest (`PrivacyInfo.xcprivacy`)
- [ ] **[YOU]** Declare:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
  <key>NSPrivacyTracking</key>
  <false/>
  <key>NSPrivacyTrackingDomains</key>
  <array/>
  <key>NSPrivacyCollectedDataTypes</key>
  <array>
    <dict>
      <key>NSPrivacyCollectedDataType</key>
      <string>NSPrivacyCollectedDataTypeEmailAddress</string>
      <key>NSPrivacyCollectedDataTypeLinked</key>
      <true/>
      <key>NSPrivacyCollectedDataTypeTracking</key>
      <false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array>
        <string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
      </array>
    </dict>
  </array>
  <key>NSPrivacyAccessedAPITypes</key>
  <array/>
</dict>
</plist>
```

---

## 7. Info.plist — Required Usage Descriptions

Verify these keys are present in `ios/mixBase/Info.plist` (add if missing):

- [ ] `NSPhotoLibraryUsageDescription` — "mixBase needs photo library access to let you choose cover art for your projects."
- [ ] `NSMicrophoneUsageDescription` — "mixBase needs microphone access to record audio directly into a project." *(add if you plan to add recording)*

---

## 8. Build & Archive

```bash
# In Xcode:
1. Product → Scheme → mixBase
2. Destination → Any iOS Device (arm64)
3. Product → Archive
4. In Organizer → Distribute App → App Store Connect → Upload
```

- [ ] **[YOU]** Bump version number in Xcode: General → Identity → Version `1.0.0`, Build `1`
- [ ] **[YOU]** Archive and upload to App Store Connect
- [ ] **[YOU]** Wait for processing (~15 min), then the build appears in TestFlight

---

## 9. TestFlight Internal Testing

- [ ] **[YOU]** Add yourself as internal tester in App Store Connect → TestFlight
- [ ] **[YOU]** Install on a real iPhone via TestFlight
- [ ] **[YOU]** Test the full flow: sign up → create project → upload audio → share → leave feedback → pipeline

---

## 10. App Store Connect — New App Setup

- [ ] **[YOU]** App Store Connect → My Apps → + New App
  - Platform: iOS
  - Name: `mixBase`
  - Primary language: English
  - Bundle ID: `com.moodmixformat.mixbase`
  - SKU: `mixbase-ios-001`

- [ ] **[YOU]** Paste all text from `docs/app-store-listing.md`
- [ ] **[YOU]** Upload screenshots to correct device slots
- [ ] **[YOU]** Set Support URL: `https://mixbase.app/support`
- [ ] **[YOU]** Set Privacy Policy URL: `https://mixbase.app/privacy`
- [ ] **[YOU]** Set Marketing URL: `https://mixbase.app` (optional)
- [ ] **[YOU]** App Review Information → add demo account credentials
- [ ] **[YOU]** Export Compliance → No (standard HTTPS only)
- [ ] **[YOU]** Content Rights → you own or have rights to all content used in screenshots
- [ ] **[YOU]** Pricing → Free (or set a price)

---

## 11. Domain Setup

The Privacy Policy and Support pages are live on Railway at:
- `https://mixbase-production.up.railway.app/privacy`
- `https://mixbase-production.up.railway.app/support`

For the App Store listing you need a stable URL. Options:
- **Option A (quick):** Use the Railway URL directly in App Store Connect.
- **Option B (professional):** Point a custom domain (e.g. `mixbase.app`) at Railway. In Railway project settings → Domains → Add Custom Domain.

- [ ] **[YOU]** Decide on URL strategy and update App Store Connect accordingly

---

## 12. Submit for Review

- [ ] **[YOU]** App Store Connect → select build → Add for Review
- [ ] **[YOU]** Submit to App Review
- Typical review time: 1–3 business days
- If rejected, check Resolution Centre in App Store Connect for the specific guideline

---

## Post-Launch

- [ ] Monitor crash reports in Xcode Organizer → Crashes
- [ ] Set up analytics (optional: PostHog, Mixpanel, or Plausible)
- [ ] Reply to App Store reviews within 24 hours
- [ ] Plan version 1.1: push notifications for feedback received, waveform recording, collaboration invites
