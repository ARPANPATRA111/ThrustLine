# THRUSTLINE for Android

The Android app is a [Trusted Web Activity](https://developer.chrome.com/docs/android/trusted-web-activity)
(TWA): a small native shell that opens [the game](https://thrustline-drab.vercel.app) full screen in the
phone's Chrome. The game itself is the website, so:

- **Every web deploy reaches the app at once.** No app update is needed for game changes.
- **It runs wherever Chrome runs.** Chrome updates itself through Google Play, so the app gets the
  same rendering engine, WebGL and audio as the browser. If a phone has no Chrome, the app falls
  back to Android's built-in WebView.
- **The app is tiny.** The release APK is about 225 KB and needs Android 7.0 or newer.
- **Progress is shared with Chrome.** The app uses Chrome's storage for the site, so a player's
  level, settings and transfer key are the same in the app and in the browser.
- **Invite links open in the app.** `https://thrustline-drab.vercel.app/?room=ABCD` links shared in
  chats open the app straight into that room once the site's asset links are live.

The shell adds a few native touches: a splash screen, landscape lock, sticky full screen that
uses the area around a notch, and an offline screen with a retry button.

React Native was considered for over-the-air updates. It would still draw the game in a WebView,
add several megabytes, and update no faster than the website already does.

## Layout

```text
app/build.gradle.kts                      version, SDK levels, signing, R8 shrinking
app/src/main/AndroidManifest.xml          site URL, display settings, invite-link filter
app/src/main/kotlin/.../LauncherActivity.kt  landscape, full screen, offline check
app/src/main/res/                         icon, splash logo, colours, offline screen
STORE_LISTING.md                          Play Store text and Play Console answers
```

## Build

Requirements: JDK 17 or newer and the Android SDK (Android Studio includes both). Set
`ANDROID_HOME`, or open this folder in Android Studio once so it writes `local.properties`.

```bash
cd android
./gradlew assembleDebug                  # app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
./gradlew lint                           # Android lint
```

Until the site lists your signing key (see [Asset links](#asset-links)), Chrome shows a URL bar
above the game. To test full screen on a device or emulator before that:

```bash
adb shell "echo '_ --disable-digital-asset-link-verification-for-url=\"https://thrustline-drab.vercel.app\"' > /data/local/tmp/chrome-command-line"
adb shell am set-debug-app --persistent com.android.chrome
adb shell am force-stop com.android.chrome
```

## Release build

Create an upload key once and keep it out of the repository. Back up the file and its password:
Play can reset a lost upload key, but it takes days.

```bash
keytool -genkeypair -v -keystore ~/thrustline-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
```

Then create `android/keystore.properties` (ignored by git):

```properties
storeFile=C:/Users/you/thrustline-upload.jks
storePassword=...
keyAlias=upload
keyPassword=...
```

```bash
./gradlew bundleRelease                  # app/build/outputs/bundle/release/app-release.aab
```

Upload the `.aab` to Play Console. Play App Signing re-signs it with Google's app signing key.

## Asset links

Chrome opens the game without a URL bar only when the website vouches for the app. The site
proves it with `client/public/.well-known/assetlinks.json`, which must list the SHA-256
fingerprint of every key that signs the app the user installs:

- the **app signing key**, shown on Play Console's app signing page after the first upload, used
  for every install from Google Play;
- the **upload key**, so sideloaded release builds work too
  (`keytool -list -v -keystore ~/thrustline-upload.jks -alias upload`).

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "io.github.arpanpatra111.thrustline",
    "sha256_cert_fingerprints": ["<APP SIGNING SHA-256>", "<UPLOAD SHA-256>"]
  }
}]
```

Deploy the website, then check both:

```bash
curl https://thrustline-drab.vercel.app/.well-known/assetlinks.json
curl "https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://thrustline-drab.vercel.app&relation=delegate_permission/common.handle_all_urls"
```

The app's side of the link is the `asset_statements` string in `res/values/strings.xml`. If the
game ever moves to another domain, change that string, `DEFAULT_URL`, `MANAGE_SPACE_URL` and the
intent filter host in the manifest, and publish an app update. Players' progress would not follow,
because browser storage belongs to the old domain.

## Updating

Game changes ship with the website (`npm run deploy` from the repo root). Only changes in this
folder need a new app release: raise `versionCode` (and `versionName`) in `app/build.gradle.kts`,
build the bundle and upload it.

Google Play requires new releases to target a recent Android version. API 36 meets the rule in
force since 31 August 2026; expect to raise `targetSdk` and `compileSdk` each August.

## Roadmap to Google Play

Personal developer accounts created after 13 November 2023 must run a closed test with at least
12 testers, opted in for 14 days in a row, before they can publish to production.

### 1. Accounts and keys

- [ ] Create a Google Play developer account (one-time fee) and finish identity verification.
- [ ] Choose the package name for good. It is `io.github.arpanpatra111.thrustline` in
      `app/build.gradle.kts` and cannot change after the first upload.
- [ ] Create the upload key and `keystore.properties`, then run `./gradlew bundleRelease`.

### 2. Play Console

- [ ] Deploy the website so the privacy policy is live at `/privacy.html`.
- [ ] Create the app: name THRUSTLINE, game, free.
- [ ] Fill in App content (privacy policy, ads, content rating, target audience, data safety)
      from [STORE_LISTING.md](STORE_LISTING.md).
- [ ] Fill in the store listing: text from STORE_LISTING.md, a 512 × 512 icon, a 1024 × 500 feature
      graphic and at least two landscape phone screenshots.

### 3. Internal testing

- [ ] Upload the bundle to the internal testing track and install it from the opt-in link.
- [ ] Copy the app signing key's SHA-256 into `client/public/.well-known/assetlinks.json` with the
      upload key's, and deploy the website again.
- [ ] Reinstall from Play and check: no URL bar, landscape, full screen, invite links open the
      app, the offline screen appears in airplane mode.

### 4. Closed testing

- [ ] Create a closed testing track, add at least 12 testers (an email list or a Google Group),
      and roll out the internal build.
- [ ] Share the opt-in link. Every tester must stay opted in for 14 consecutive days.
- [ ] Merge this branch into `main`.
- [ ] Fix what testers report. Web fixes ship with `npm run deploy`; shell fixes need a new
      `versionCode`.

### 5. Production

- [ ] After 14 days, apply for production access in the Dashboard and answer the questions about
      the test. Review usually takes about a week.
- [ ] Release to production with a staged rollout (for example 20 %, then 100 %).
- [ ] Watch Android vitals and the pre-launch report, and reply to reviews.

### Later

- Raise `targetSdk` before each August deadline.
- Add tablet screenshots and a short gameplay video to the listing.
- A real Android phone on a low-end chip is the best test bed for the quality settings.
