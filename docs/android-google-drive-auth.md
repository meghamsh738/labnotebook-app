# Android Google Drive Auth Foundation

Easylab uses an account-first Google Drive workspace across desktop, PWA, and Android. The primary Android application is a native Jetpack Compose app using package id `com.easylab.labnotebook`. A Capacitor activity remains only as a temporary compatibility and migration surface while native feature parity is completed.

## Current Implementation

The primary Compose activity uses native Android authentication/session handling. The retained Capacitor compatibility activity registers a plugin named `GoogleDriveAuth` for the legacy React bridge.

- Plugin file: `android/app/src/main/java/com/easylab/labnotebook/GoogleDriveAuthPlugin.java`
- Compatibility registration: `android/app/src/main/java/com/easylab/labnotebook/LegacyWebActivity.java`
- Native entry point: `android/app/src/main/java/com/easylab/labnotebook/MainActivity.java`
- Google Play Services dependency: `com.google.android.gms:play-services-auth`

The compatibility plugin uses Google's native authorization client to request the Drive scope and returns only a short-lived access token plus profile metadata to the React layer. The web app never stores Android access tokens in `localStorage` or IndexedDB; it stores only account/folder metadata through the existing `DriveConnectionState`.

The debug APK build requires a local Java runtime and Android SDK. On this Mac, Java 21 and the Android command-line tools are installed locally, and `npm run android:build:debug` produces `android/app/build/outputs/apk/debug/app-debug.apk`.

## Google Cloud Setup

Create or update these OAuth clients in the same Google Cloud project:

- Web app client for local PWA/dev origins such as `http://127.0.0.1:5173`.
- Desktop app client for Electron loopback PKCE OAuth.
- Android client for package `com.easylab.labnotebook`.

For the Android client, add the SHA fingerprints for every build channel:

- Debug SHA-1/SHA-256 from the local debug keystore.
- Release SHA-1/SHA-256 from the Play signing key or release upload key, depending on distribution.

Current local debug OAuth registration values:

```text
Package name: com.easylab.labnotebook
Debug SHA-1: E8:63:C8:4B:0D:6C:C9:9A:61:79:88:55:83:78:FF:72:5F:E7:10:DE
```

If Android sign-in returns immediately to the app with a generic connection error, check Google Play Services logcat for `UNREGISTERED_ON_API_CONSOLE`; that means the Android OAuth client is missing this package/SHA-1 pair.

Enable the Google Drive API and request only these scopes:

```text
openid email profile https://www.googleapis.com/auth/drive.file
```

Public release still needs a complete OAuth consent screen with privacy policy, terms/support links, authorized domains/origins, and likely Google verification for the Drive scope.

## Web Layer Contract

The shared React sync provider now checks for a Capacitor plugin before browser GIS:

```ts
window.Capacitor?.Plugins?.GoogleDriveAuth?.requestAccessToken({
  clientId,
  scope: 'openid email profile https://www.googleapis.com/auth/drive.file',
})
```

The native plugin returns only a short-lived access token plus non-sensitive profile metadata:

```ts
{
  accessToken: string,
  expiresIn?: number,
  scope?: string,
  tokenType?: string,
  account?: {
    provider: 'google',
    email: string,
    name?: string,
    picture?: string,
    subject?: string
  }
}
```

Do not persist access tokens in `localStorage` or IndexedDB. The web layer stores account profile and Drive folder metadata only. Native Android owns sign-in/session handling through official Google APIs and returns fresh access tokens when sync needs them.

## Native Plugin Behavior

`requestAccessToken` accepts:

```ts
{
  scope?: string
}
```

It defaults to:

```text
openid email profile https://www.googleapis.com/auth/drive.file
```

It resolves with:

```ts
{
  accessToken: string
  tokenType: 'Bearer'
  scope?: string
  expiresIn?: number
  account?: {
    provider: 'google'
    email?: string
    name?: string
    picture?: string
    subject?: string
  }
}
```

`disconnect` revokes the last requested scopes for the cached native account when available.

## Build Commands

```bash
npm run android:sync
npm run android:build:debug
```

`android:sync` builds the web app into `.labnote-dist/web` and syncs it into Capacitor. `android:build:debug` produces the debug APK once the Android SDK/Gradle environment is available.

## QA Checklist

- Install Java and Android SDK/command-line tools.
- Run `npm run android:build:debug`.
- Install the debug APK on an emulator or device with `adb install`.
- Launch the app and confirm the account gate calls `GoogleDriveAuth.requestAccessToken`.
- Confirm the app receives account metadata and a short-lived token.
- Confirm web storage contains only profile/folder metadata, not access tokens.
- Confirm sync creates or recovers the `Easylab Lab Notebook` Drive folder for the signed-in Gmail account.
