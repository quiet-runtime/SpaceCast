# Privacy

SpaceCast runs in your browser. It has no account system, analytics, advertising, telemetry, or developer-operated upload service.

## Network access

SpaceCast runs on `x.com` and `twitter.com`. It requests Space details through X using the current browser session, then fetches the audio playlists and segments supplied by X. Displayed participant avatars may load from X's image services. These requests expose the normal connection information, such as your IP address, to the services receiving them.

Existing X session cookies and request tokens are used locally to access X; SpaceCast does not transmit them to its developer or store a separate copy. Media segment requests omit browser credentials. SpaceCast does not bypass X's access restrictions.

## Local storage

- **Appearance preferences** are saved in the extension's local browser storage.
- **Window position, window size, equalizer settings, and video preferences** are saved in the X site's local storage in your browser profile.
- **Rewind audio** is held in a session-specific IndexedDB database in X's site storage, or a bounded memory cache if that database is unavailable. The extension attempts to delete its session database when the session ends. An abrupt browser or system shutdown can leave temporary data until the site's storage is cleared.
- **Recordings** are assembled locally and saved through the browser's download mechanism when you choose a recording action. File names and audio metadata can include the Space title, host, URL, and recording time. SpaceCast does not upload the resulting files.
- **Participant snapshots** used while browsing remain in memory for the current session.

Site storage belongs to the X origin; it is not an encrypted extension vault. Clearing X's site data removes the site-stored preferences and caches, but also affects X's own data and may sign you out. Remove downloaded recordings separately through your file manager. Browser controls manage the extension's own stored preferences.

## Permissions and capture

The extension requests the `storage` permission to save its appearance preferences. Its content scripts run only on X and Twitter pages so they can integrate the player with a Space.

Video recording is optional and opens the browser's screen-sharing picker. Capture starts only after you select a source and approve sharing. SpaceCast requires the browser to frame the capture to the Space; it stops video if that framing cannot be maintained. SpaceCast does not request microphone access.

Copying a stream link places it on your clipboard when you click the relevant control. A stream URL may contain temporary access parameters; anyone you share it with receives that URL.

X and your browser have their own privacy policies. This document describes SpaceCast's behavior only.
