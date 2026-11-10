import { readConfig } from './config.mjs';
import { Store } from './store.mjs';
import { DiscordClient } from './discord.mjs';
import { Service } from './service.mjs';
import { createHttpServer } from './http.mjs';
import { AccountService } from './accounts.mjs';
import { DiscordControl } from './discord-control.mjs';
import { CommunityControl } from './community-control.mjs';
import { TikTokLive } from './tiktok-live.mjs';
import { AdminCrowns } from './admin-crowns.mjs';
import { JoinRequests } from './join-requests.mjs';
import { DeviceRoles } from './device-roles.mjs';
import { GamingSetups } from './gaming-setups.mjs';
import { SetupPanel } from './setup-panel.mjs';
import { JoinRole } from './join-role.mjs';
import { attachEmailAccess } from './email-access.mjs';
import { BirthdayService } from './birthdays.mjs';
import { BotService } from './bot.mjs';
import { BotGateway } from './bot-gateway.mjs';
import { MusicBot } from './music-bot.mjs';
import { MusicRemote } from './music-remote.mjs';
import { DiscordDirectory } from './discord-directory.mjs';
import { ControlExtras } from './control-extras.mjs';
import { ControlMembers } from './control-members.mjs';
import { PCSupport } from './pc-support.mjs';
import { ControlPush } from './control-push.mjs';

process.umask(0o077);
const config = readConfig();
// Email approvals no longer require a Discord owner to operate. The optional
// legacy CMS still enforces its explicit Discord owner separately.
config.configured = config.discordConfigured;
let store;
try { store = new Store(config.dataDir); }
catch { console.error('Crazy_Batto Discord App: Die private Datenbank konnte nicht sicher geöffnet werden. Dateirechte, Schlüssel und laufende Instanzen prüfen.'); process.exit(1); }
const service = new Service(config, store, new DiscordClient(config));
service.accounts = new AccountService(config);
service.controlMembers = new ControlMembers(service.accounts);
service.accounts.controlMembers = service.controlMembers;
service.pcSupport = new PCSupport(service);
service.accounts.pcSupport = service.pcSupport;
service.controlPush = new ControlPush(service.accounts);
attachEmailAccess(service);
service.birthdays = new BirthdayService(service);
service.accounts.birthdays = service.birthdays;
service.communityControl = new CommunityControl(service);
service.tiktokLive = new TikTokLive(service);
service.adminCrowns = new AdminCrowns(service);
service.joinRequests = new JoinRequests(service);
service.deviceRoles = new DeviceRoles(service);
service.gamingSetups = new GamingSetups(service);
service.setupPanel = new SetupPanel(service);
service.autoJoinRole = new JoinRole(service);
service.controlExtras = new ControlExtras(service);
service.accounts.gamingSetups = service.gamingSetups;
service.botAdmin = new BotService(service);
service.botGateway = new BotGateway(config, {
  onDispatch: packet => { service.musicBot?.gatewayEvent(packet); return Promise.allSettled([
    Promise.resolve().then(() => service.communityControl.gatewayEvent(packet)),
    Promise.resolve().then(() => service.autoJoinRole.gatewayEvent(packet)),
    Promise.resolve().then(() => service.controlExtras.gatewayEvent(packet)),
  ]); },
  intentResolver: () => service.controlExtras.gatewayIntents(),
  onConnectionState: phase => { service.musicBot?.connectionState(phase); service.controlExtras.connectionState(phase); },
});
service.musicBot = new MusicBot(service);
service.musicRemote = new MusicRemote(service);
service.discordDirectory = new DiscordDirectory(service);
service.accounts.botStatus = () => service.botAdmin.status();
service.discordControl = new DiscordControl(service);
const server = createHttpServer(service);
server.listen(config.port, config.host, () => {
  service.botGateway.start();
  service.birthdays.start();
  service.communityControl.start();
  service.tiktokLive.start();
  service.gamingSetups.start();
  service.autoJoinRole.start();
  service.controlExtras.start();
  console.log('Crazy_Batto Plattform 2.3.2 läuft auf Port ' + config.port + '.');
  if (!config.configured) console.log('Discord ist noch nicht eingerichtet. /health meldet configured:false.');
});
server.on('error', async () => { console.error('Crazy_Batto Discord App: Der HTTP-Server konnte nicht gestartet werden.'); service.controlPush.close(); service.musicBot.stop(); service.botGateway.stop(); await Promise.allSettled([service.birthdays.stop(), service.communityControl.stop(), service.tiktokLive.stop(), service.gamingSetups.stop(), service.autoJoinRole.stop(), service.controlExtras.stop()]); service.accounts.close(); store.close(); process.exit(1); });
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  service.controlPush.close();
  service.musicBot.stop(); service.botGateway.stop();
  const timer = setTimeout(() => process.exit(1), 170_000); timer.unref();
  await Promise.allSettled([service.birthdays.stop(), service.communityControl.stop(), service.tiktokLive.stop(), service.gamingSetups.stop(), service.autoJoinRole.stop(), service.controlExtras.stop()]);
  await new Promise(resolve => server.close(resolve));
  await Promise.allSettled([...service.running.values()]);
  service.accounts.close(); store.close(); clearTimeout(timer); process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
