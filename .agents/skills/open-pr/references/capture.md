# Capture reference — Android emulator · iOS simulator · web

Generic commands. The project profile (`.agents/open-pr.md`) gives the real module paths, IDs, launch arguments and pitfalls. When the two differ, the profile wins.

## Common rules

- **Capture from the committed branch.** Uncommitted changes appear on screen but not in the PR.
- **Do not trust the first capture of a default debug build.** Check the profile's pitfall table first (login gates, signing, backend URLs).
- For ad screens, capture a **loaded test ad**. Do not upload a "loading" state.
- For platform parity, put two images of similar frame width under one sub-heading.

## Android

```bash
adb devices                                   # pick one serial; set ANDROID_SERIAL when more than one is attached
./gradlew :<app-module>:installDebug
adb shell am start -n <applicationId>/<launch activity>
adb exec-out screencap -p > media/android-home.png
adb shell screenrecord --time-limit 15 /sdcard/flow.mp4 && adb pull /sdcard/flow.mp4 media/android-flow.mp4
```

- Dark mode: `adb shell "cmd uimode night yes|no"`.
- Navigate with `adb shell input tap <x> <y>`, `input swipe …`, `input text …`. Find coordinates with `adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml`.
- Never use a physical device that the user did not name.

## iOS

```bash
xcrun simctl list devices available            # pick a UDID
xcrun simctl boot <udid> 2>/dev/null; xcrun simctl bootstatus <udid> -b
xcodebuild -project <App>.xcodeproj -scheme <Scheme> \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build build
xcrun simctl install <udid> build/Build/Products/Debug-iphonesimulator/<App>.app
xcrun simctl launch <udid> <bundle id> <launch arguments>
xcrun simctl io <udid> screenshot media/ios-home.png
xcrun simctl io <udid> recordVideo media/ios-flow.mov   # stop with ctrl+c (SIGINT)
```

- Appearance: `xcrun simctl ui <udid> appearance light|dark`.
- If the project uses XcodeGen or Tuist, generate the project first.
- Keep code signing on for simulator builds when the app uses the keychain. `CODE_SIGNING_ALLOWED=NO` breaks keychain access.
- If `simctl launch` hangs, shut down the simulator and boot it again.

## Web

Start the dev server (profile `Web` section), then capture with a headless browser:

```bash
npx playwright screenshot --viewport-size=1280,800 --wait-for-timeout=2000 http://localhost:3000/<route> media/web-page.png
```

For a flow, write a short Playwright script with `recordVideo` in the browser context. Save the video in `media/`.

## Video frame sheets (for step 5)

You cannot play a video. Extract frames and read them:

```bash
ffmpeg -loglevel error -i media/flow.mp4 -vf "fps=1,scale=360:-1,tile=5x2" -frames:v 1 check/flow-sheet.png
```

## Layout in the body

- Large device frames shrink to the body width. Crop unrelated status bars and home indicators.
- GitHub accepts `.mov` and `.mp4` attachments. A video renders as a player only when it stands alone on a line.
- Image references inside tables are not always replaced by upload URLs. List images one by one.
