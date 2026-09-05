# Infovore Health for Android

This private companion (current version 0.1.3) reads selected records from Android Health Connect and
uploads them to infovore's authenticated ingest service. Garmin Connect can
write its activity and wellness records to Health Connect on Android 14+; this
app then transports those records to infovore without handling Garmin or
Google account credentials.

## Data and privacy

The app requests read-only access to exercise sessions, steps, distance, total
calories, heart rate, sleep, weight, and body fat. Exercise routes are not
requested. The ingest token is encrypted with Android Keystore, Android backup
is disabled, and the server keeps raw Health Connect records outside the public
activity, feed, and MCP projections. Infovore's Health platform page uses only
safe aggregates and recent workout summaries.

## Setup

1. Set a random `HEALTH_CONNECT_TOKEN` of at least 32 characters on the
   infovore ingest service. If it is omitted, the server falls back to
   `INGEST_TOKEN` for backward compatibility.
2. Make the ingest service reachable from the phone. The bundled build defaults
   to `https://infovore.skyhong.tw`. For local testing it also allows
   `http://100.85.214.25:3001`; that private address is transported inside
   Tailscale's encrypted tunnel. Other endpoints must use HTTPS.
3. In Garmin Connect, enable writing data to Health Connect.
4. Install the APK, enter the endpoint and token, save, and grant Health Connect
   permissions.
5. Tap **立即同步** for the first import. The app displays progress and uploads
   each Health Connect page as it is read. During a manual import it keeps the
   display awake and retries transient connection failures up to four times.
   WorkManager checks for changes every six hours while a network is available.

The initial import reads 30 days unless the optional Health Connect history
permission is available and granted, in which case it reads up to ten years.
Historical data is uploaded in sleep, exercise, and steps order before the
remaining record types, so sleep summaries become available without waiting
for the much larger granular step history.
Subsequent imports use Health Connect change tokens and apply both upserts and
deletions. Change tokens expire after 30 days, so an expired token safely falls
back to another historical scan.

## Build

Install JDK 17 and Android SDK platform 36, then run:

```sh
cd android
./gradlew assembleDebug lintDebug
```

The APK is written to `app/build/outputs/apk/debug/app-debug.apk`. GitHub Actions
also publishes it as the `infovore-health-debug` workflow artifact.
