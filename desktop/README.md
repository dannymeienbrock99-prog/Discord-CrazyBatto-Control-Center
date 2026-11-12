# Crazy_Batto Control Center 3.7.1

Windows Electron app with German React UI: existing crazybatto.de admin account, birthdays, music, authenticated Discord administration extension, encrypted profiles and SFTP. Version 3.5 adds private PC-support requests with reviewed price offers, website-member approvals and synchronized Robot SchichtLog records with reversible deletion and explicit conflict resolution.

Version 3.7.1 improves Robot SchichtLog: device-specific setup guidance, explicit active/deleted record views, and private photos loaded in pages of 40 until the complete gallery is available. Photo responses are checked against the selected record and revision; delayed pages cannot overwrite an edited draft or another order. Pairing and permission guidance correspond to Robot SchichtLog 1.9.0. The desktop only displays real synchronized records and never turns a photo into an invented order.

Version 3.7.0 adds **Website-Aufrufe**, an administrator-only view of the existing website visitor statistics: today's guest page views and estimated daily visitors, 7/30/90-day trends, most viewed pages and cumulative views since collection began. It uses the existing authenticated API without adding tracking. Only the public pages already included in the website counter are covered; authenticated members and recognized bots are excluded. Daily visitor estimates are not unique people across a longer period. Loading, unavailable, incomplete and empty data are distinguished, and account changes discard pending responses.

Version 3.5.1 includes the new gold-marble banners: the PC-help invitation prepares its banner in the embed editor, and the rules editor can insert the matching rules banner. Both remain editable drafts; saving and publishing are separate explicit actions.

Version 3.6.1 adds report moderation with explicit private warnings, server voice mute/unmute, temporary Discord timeouts/removal, kick, ban and deliberate case closure. Decisions preserve the reviewed report revision, require reasons and confirmations, and retain a history. Uncertain outcomes are not automatically retried. Mobile report management and notifications run through the deployed website.

Version 3.6.0 added a local Stream Deck connection for Spotify playback, volume, shuffle, repeat, selected links and devices; Discord music controls; and opening Control Center pages. The Windows pairing key is stored encrypted, the bridge listens only on loopback, and queued commands retain the website account active when they were received. Spotify shuffle and repeat are also available directly in the desktop player. Enable the connection and pair the separate Stream Deck plugin in the app; the bridge does not expose server administration or moderation commands.

Installation: [setup guide](../docs/INSTALLATION.md). Website details: [configuration](../docs/CONFIGURATION.md). Server source: `../server/`. Verified results: [validation](../docs/VALIDATION.md).

## Development

`npm ci`, `npm run build`, `npm start`. `npm run dev` starts a local development renderer; authenticated features require their actual connected services. Use `VITE_DEV_SERVER_URL` for an Electron development renderer. `npm run package` builds the Windows x64 installer and portable executable in `release/`. Build output remains local; no public download is created.

`npm test` checks validation, storage, website API/auth, profiles, mocked SFTP and real SFTP exclusively on loopback. It requires local network permission, uses temporary files and invented credentials. Server-package tests are separate.

## Architecture

- `src/components/WebsitePages.jsx`: account, birthdays, music, historical feature inventory.
- `MembersPage.jsx`, `SupportAdminPage.jsx`, `RobotOrdersPage.jsx`: website-wide approvals, PC-help review and real synchronized Robot records, independent of a selected Discord server.
- `electron/workspace-operations.cjs`: fixed authenticated website routes, bounded private image previews and exact revision-aware review requests.
- `src/components/ConnectionsPanel.jsx`: profiles and two-pane file transfer.
- `EmbedEditor.jsx`, `Templates.jsx`, `AdminPages.jsx`: Discord administration and templates.
- `electron/main.cjs`: isolated window, native dialogs, IPC allowlist and explicit connection routing.
- `electron/website.cjs`: fixed API routes, admin verification, sessions and expected bot identity.
- `electron/connections.cjs`: encrypted secrets, SSH host-key trust and bounded SFTP operations.
- `electron/streamdeck.cjs`: authenticated loopback bridge, constrained music actions and account-bound queued commands.
- `service.cjs`, `discord-client.cjs`, `validation.cjs`: Discord workflows reused by the server package.
- `storage.cjs`: local templates and optional encrypted direct-bot credential.

Website mode never silently falls back to a direct bot after expiry. Direct-token mode is an explicit advanced option. Stored secrets never return to the renderer or appear in template exports. Context isolation, renderer sandboxing and disabled Node integration are enabled. The app starts no Gateway process.

The website session, SFTP login and member Discord link are separate identities. Website-authenticated Discord editing needs the accompanying server extension deployed. Historical Kori runtime modules are inventoried, not yet migrated or activated. The UI distinguishes existing functionality and unfinished plans.

Original logo and marble texture: user's website. Optional community banner: AI-generated for this app.
