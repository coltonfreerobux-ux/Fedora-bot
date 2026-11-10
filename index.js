/**
 * GFX ANTIRAID — Discord bot + web control panel
 *
 * Required environment variables:
 *   BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, SESSION_SECRET
 * Optional:
 *   PORT=3000
 *   CALLBACK_URL=https://your-domain.example/callback
 *
 * Discord Developer Portal:
 *   Enable SERVER MEMBERS INTENT and PRESENCE INTENT.
 * Bot permissions:
 *   View Channels, Manage Roles, Kick Members, Ban Members, Moderate Members,
 *   View Audit Log. The bot's highest role must be above roles it manages.
 *
 * Install:
 *   npm install express express-session passport passport-discord discord.js
 */

"use strict";

const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const {
    Client,
    GatewayIntentBits,
    AuditLogEvent,
    REST,
    Routes,
    Partials,
    PermissionFlagsBits,
    ChannelType
} = require("discord.js");

const app = express();

const PRIMARY_GUILD_ID = "1468021969638392080";
const RAID_MANAGER_ROLE_ID = "1530291208784449688";

// These role names are also allowed to access the live dashboard and commands.
// Use the exact Discord role names, without the @ mention.
const ADDITIONAL_ACCESS_ROLE_NAMES = new Set([
    "[H-ADM] HeadAdmin",
    "[SH] Server Holder",
    "[SO] Server Owner",
    "[SCO] Server Co-Owner",

].map(name => name.trim().toLowerCase()));

const PORT = Number(process.env.PORT || 3000);
const CALLBACK_URL =
    process.env.CALLBACK_URL || "https://gfx-antiraid.onrender.com/callback";

if (!process.env.BOT_TOKEN || !process.env.CLIENT_ID || !process.env.CLIENT_SECRET) {
    throw new Error("Missing BOT_TOKEN, CLIENT_ID, or CLIENT_SECRET environment variable.");
}
if (!process.env.SESSION_SECRET) {
    throw new Error("Set SESSION_SECRET to a long, random secret before starting the website.");
}

let antiraidEnabled = false;
const modLogs = new Map();

function addModLog(userId, action, moderatorId = "SYSTEM") {
    if (!modLogs.has(userId)) modLogs.set(userId, []);
    const logs = modLogs.get(userId);
    logs.unshift({
        action: String(action).slice(0, 500),
        moderatorId,
        timestamp: Date.now()
    });
    if (logs.length > 100) logs.length = 100;
}

const bot = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
         GatewayIntentBits.DirectMessages
    ],
    partials: [
    Partials.Channel
]
});

const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);

async function getGuild() {
    let guild = bot.guilds.cache.get(PRIMARY_GUILD_ID);
    if (!guild) {
        try {
            guild = await bot.guilds.fetch(PRIMARY_GUILD_ID);
        } catch {
            return null;
        }
    }
    return guild || null;
}

function hasPermission(member, permission) {
    return Boolean(member && member.permissions.has(permission));
}

function isAuthorizedStaff(member) {
    if (!member) return false;
    if (member.roles.cache.has(RAID_MANAGER_ROLE_ID)) return true;
    return member.roles.cache.some(role =>
        ADDITIONAL_ACCESS_ROLE_NAMES.has(role.name.trim().toLowerCase())
    );
}

function roleIsManageable(guild, actor, target, role) {
    if (!role || role.id === guild.id || role.managed) return false;
    if (role.position >= guild.members.me.roles.highest.position) return false;
    if (actor.id !== guild.ownerId &&
        role.position >= actor.roles.highest.position) return false;
    if (target && role.position >= target.roles.highest.position) return false;
    return true;
}

function canModerateTarget(guild, actor, target) {
    if (!actor || !target || target.id === guild.ownerId || target.id === actor.id) {
        return false;
    }
    if (actor.id !== guild.ownerId &&
        target.roles.highest.position >= actor.roles.highest.position) {
        return false;
    }
    if (target.roles.highest.position >= guild.members.me.roles.highest.position) {
        return false;
    }
    return true;
}

async function fetchGuildData() {
    const guild = await getGuild();
    if (!guild) throw new Error("The bot is not connected to the configured Discord server.");

    await guild.channels.fetch();
    await guild.roles.fetch();
    await guild.members.fetch({ withPresences: true });

    const channels = [...guild.channels.cache.values()]
        .filter(channel => channel.guildId === guild.id)
        .sort((a, b) => {
            const categoryA = a.parent ? a.parent.position : a.position;
            const categoryB = b.parent ? b.parent.position : b.position;
            return categoryA - categoryB || a.position - b.position;
        })
        .map(channel => ({
            id: channel.id,
            name: channel.name,
            type: ChannelType[channel.type] || String(channel.type),
            position: channel.position,
            parentName: channel.parent?.name || null,
            parentId: channel.parentId || null
        }));

    const roles = [...guild.roles.cache.values()]
        .sort((a, b) => b.position - a.position)
        .map(role => ({
            id: role.id,
            name: role.name,
            color: role.hexColor,
            position: role.position,
            memberCount: guild.members.cache.filter(member =>
                member.roles.cache.has(role.id)
            ).size,
            managed: role.managed,
            everyone: role.id === guild.id
        }));

    const members = [...guild.members.cache.values()]
        .map(member => ({
            id: member.id,
            username: member.user.username,
            displayName: member.displayName,
            avatar: member.user.displayAvatarURL({ size: 64 }),
            bot: member.user.bot,
            status: member.presence?.status || "offline",
            activity: member.presence?.activities?.[0]?.name || null,
            highestRole: member.roles.highest.name,
            highestRolePosition: member.roles.highest.position,
            roles: member.roles.cache
                .filter(role => role.id !== guild.id)
                .sort((a, b) => b.position - a.position)
                .map(role => role.name),
            isRaidManager: isAuthorizedStaff(member)
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));

    const onlineCount = members.filter(member =>
        ["online", "idle", "dnd"].includes(member.status)
    ).length;

    return {
        guild: {
            id: guild.id,
            name: guild.name,
            icon: guild.iconURL({ size: 128 }),
            memberCount: guild.memberCount,
            onlineCount,
            channelCount: channels.length,
            roleCount: roles.length
        },
        channels,
        roles,
        members,
        raidManagers: members.filter(member => member.isRaidManager),
        antiraidEnabled
    };
}

// -------------------------------
// Slash commands (also available in Discord)
// -------------------------------
async function registerCommands() {
    const commands = [
        {
            name: "antiraid",
            description: "Ban a user for antiraid protection",
            options: [{ name: "user", description: "User to ban", type: 6, required: true }]
        },
        {
            name: "addrole",
            description: "Add a role to a user",
            options: [
                { name: "user", description: "User to modify", type: 6, required: true },
                { name: "role", description: "Role to add", type: 8, required: true }
            ]
        },
        {
            name: "removerole",
            description: "Remove a role from a user",
            options: [
                { name: "user", description: "User to modify", type: 6, required: true },
                { name: "role", description: "Role to remove", type: 8, required: true }
            ]
        },
        {
            name: "kick",
            description: "Kick a user",
            options: [{ name: "user", description: "User to kick", type: 6, required: true }]
        },
        {
            name: "modlogs",
            description: "Show moderation logs for a user",
            options: [{ name: "user", description: "User to view logs for", type: 6, required: true }]
        }
    ];

    try {
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, PRIMARY_GUILD_ID),
            { body: commands }
        );
        console.log("Slash commands registered.");
    } catch (error) {
        console.error("Slash command registration failed:", error);
    }
}

bot.once("ready", async () => {
    console.log(`Bot ready as ${bot.user.tag}`);
    await registerCommands();
});

bot.on("error", error => console.error("Discord client error:", error));

bot.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    try {
        const guild = await getGuild();
        if (!guild) {
            return interaction.reply({ content: "Bot is not in the configured server.", ephemeral: true });
        }

        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        if (!isAuthorizedStaff(member)) {
            return interaction.reply({ content: "You do not have permission.", ephemeral: true });
        }

        if (interaction.commandName === "modlogs") {
            const target = interaction.options.getUser("user");
            const logs = modLogs.get(target.id) || [];
            const formatted = logs.slice(0, 15).map(log =>
                `• ${log.action} — ${new Date(log.timestamp).toLocaleString()}`
            ).join("\n");
            return interaction.reply({
                content: logs.length ? `Modlogs for ${target.tag}:\n${formatted}` : `No logs found for ${target.tag}.`,
                ephemeral: true
            });
        }

        const targetUser = interaction.options.getUser("user");
        const target = await guild.members.fetch(targetUser.id).catch(() => null);
        if (!target) {
            return interaction.reply({ content: "That member could not be found.", ephemeral: true });
        }
        if (!canModerateTarget(guild, member, target)) {
            return interaction.reply({ content: "Discord role hierarchy prevents that action.", ephemeral: true });
        }

        if (interaction.commandName === "kick") {
            if (!hasPermission(member, PermissionFlagsBits.KickMembers) ||
                !hasPermission(guild.members.me, PermissionFlagsBits.KickMembers)) {
                return interaction.reply({ content: "You or the bot lack Kick Members permission.", ephemeral: true });
            }
            await target.kick("Manual kick by Raid Manager");
            addModLog(target.id, "Kicked via Discord command", interaction.user.id);
            return interaction.reply({ content: `Kicked ${targetUser.tag}.`, ephemeral: true });
        }

        if (interaction.commandName === "antiraid") {
            if (!hasPermission(member, PermissionFlagsBits.BanMembers) ||
                !hasPermission(guild.members.me, PermissionFlagsBits.BanMembers)) {
                return interaction.reply({ content: "You or the bot lack Ban Members permission.", ephemeral: true });
            }
            await target.ban({ reason: "Manual antiraid ban" });
            addModLog(target.id, "Manual antiraid ban", interaction.user.id);
            return interaction.reply({ content: `Banned ${targetUser.tag}.`, ephemeral: true });
        }

        if (interaction.commandName === "addrole" || interaction.commandName === "removerole") {
            if (!hasPermission(member, PermissionFlagsBits.ManageRoles) ||
                !hasPermission(guild.members.me, PermissionFlagsBits.ManageRoles)) {
                return interaction.reply({ content: "You or the bot lack Manage Roles permission.", ephemeral: true });
            }
            const role = interaction.options.getRole("role");
            if (!roleIsManageable(guild, member, target, role)) {
                return interaction.reply({ content: "That role cannot be managed because of role hierarchy or role type.", ephemeral: true });
            }
            if (interaction.commandName === "addrole") {
                await target.roles.add(role);
                addModLog(target.id, `Role added: ${role.name}`, interaction.user.id);
                return interaction.reply({ content: `Added ${role.name} to ${targetUser.tag}.`, ephemeral: true });
            }
            await target.roles.remove(role);
            addModLog(target.id, `Role removed: ${role.name}`, interaction.user.id);
            return interaction.reply({ content: `Removed ${role.name} from ${targetUser.tag}.`, ephemeral: true });
        }
    } catch (error) {
        console.error("Slash command failed:", error);
        const message = "The command failed. Check the bot's permissions and role hierarchy.";
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
        } else {
            await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
        }
    }
});
// -------------------------------
// OAuth, sessions, and dashboard auth
// -------------------------------
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

passport.use(new DiscordStrategy(
    {
        clientID: process.env.CLIENT_ID,
        clientSecret: process.env.CLIENT_SECRET,
        callbackURL: CALLBACK_URL,
        scope: ["identify", "guilds"]
    },
    (accessToken, refreshToken, profile, done) => {
        process.nextTick(() => done(null, profile));
    }
));

app.set("trust proxy", 1);
app.use(session({
    name: "gfx.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 8 * 60 * 60 * 1000
    }
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(express.json({ limit: "20kb" }));

async function requireRaidManager(req, res, next) {
    if (!req.user) {
        if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Please log in." });
        return res.redirect("/login");
    }

    try {
        const guild = await getGuild();
        if (!guild) {
            if (req.path.startsWith("/api/")) return res.status(503).json({ error: "Bot is not connected to the server." });
            return res.status(503).send("Bot is not connected to the configured server.");
        }

        const member = await guild.members.fetch(req.user.id).catch(() => null);
        if (!isAuthorizedStaff(member)) {
            if (req.path.startsWith("/api/")) return res.status(403).json({ error: "You need the Raid Manager role or one of the authorized staff roles." });
            return res.status(403).send("You do not have an authorized staff role.");
        }

        req.guild = guild;
        req.guildMember = member;
        next();
    } catch (error) {
        console.error("Dashboard authorization failed:", error);
        return res.status(500).json({ error: "Could not verify your Discord permissions." });
    }
}

function requireActorPermission(permission) {
    return (req, res, next) => {
        if (!hasPermission(req.guildMember, permission)) {
            return res.status(403).json({ error: "Your Discord account lacks the required permission." });
        }
        if (!hasPermission(req.guild.members.me, permission)) {
            return res.status(503).json({ error: "The bot lacks the required Discord permission." });
        }
        next();
    };
}

app.get("/", (req, res) => res.redirect("/dashboard"));

app.get("/login", (req, res) => {
    res.send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GFX Antiraid Login</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080d19;color:#edf2ff;font:16px Arial}
main{width:min(440px,92vw);padding:42px;background:#111b2d;border:1px solid #263752;border-radius:18px;text-align:center}
h1{margin-top:0}p{color:#aab8ce;line-height:1.6}a{display:inline-block;padding:13px 20px;background:#5865f2;color:white;text-decoration:none;border-radius:9px;font-weight:bold}
</style></head><body><main><h1>GFX Antiraid</h1><p>Sign in with Discord. Access is limited to members with the Raid Manager role or one of the configured staff roles.</p><a href="/auth">Login with Discord</a></main></body></html>`);
});

app.get("/auth", passport.authenticate("discord"));

app.get("/callback",
    passport.authenticate("discord", { failureRedirect: "/login" }),
    (req, res) => res.redirect("/dashboard")
);

app.post("/logout", (req, res) => {
    req.logout(() => {
        req.session.destroy(() => res.redirect("/login"));
    });
});

// -------------------------------
// Dashboard page
// -------------------------------
app.get("/dashboard", requireRaidManager, (req, res) => {
    const displayName = req.user.username || "Raid Manager";
    res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GFX Antiraid Control Panel</title>
<style>
:root{color-scheme:dark;--bg:#080d19;--panel:#111b2d;--panel2:#0d1728;--line:#263752;--muted:#9aabc4;--text:#edf2ff;--accent:#7185ff;--green:#35c98a;--red:#f06b78}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px Inter,Arial,sans-serif}
header{height:76px;display:flex;align-items:center;justify-content:space-between;padding:0 28px;border-bottom:1px solid var(--line);background:#0b1423;position:sticky;top:0;z-index:3}
.brand{font-size:19px;font-weight:800;letter-spacing:.3px}.brand span{color:var(--accent)}.user{display:flex;gap:14px;align-items:center;color:var(--muted)}
button,.button{border:0;border-radius:8px;padding:10px 14px;background:var(--accent);color:white;font-weight:700;cursor:pointer}
button.secondary{background:#253650}button.danger{background:#a83d50}button:disabled{opacity:.45;cursor:not-allowed}
main{max-width:1500px;margin:auto;padding:26px}.welcome{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}
h1{font-size:25px;margin:0 0 6px}.muted{color:var(--muted)}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:18px}
.card,.section{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:17px;min-width:0}
.stat-label{color:var(--muted);font-size:12px}.stat-value{font-size:27px;font-weight:800;margin-top:8px}
.grid{display:grid;grid-template-columns:1.1fr 1fr;gap:16px}.section{margin-bottom:16px}.section-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}
h2{font-size:16px;margin:0}.tabs{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 17px}
.tab{background:#17243a;color:#b9c8df}.tab.active{background:var(--accent);color:white}
.list{display:flex;flex-direction:column;gap:7px;max-height:440px;overflow:auto}
.item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 11px;background:var(--panel2);border:1px solid #1e2d45;border-radius:9px;min-width:0}
.item-main{display:flex;align-items:center;gap:10px;min-width:0}.item-name{font-weight:700;overflow-wrap:anywhere}.sub{font-size:11px;color:var(--muted);margin-top:4px}
.avatar{width:34px;height:34px;border-radius:50%;background:#273854;object-fit:cover}.dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:6px;background:#69778e}.online{background:#35c98a}.idle{background:#f0b84c}.dnd{background:#f06b78}
.pill{font-size:11px;padding:4px 7px;border-radius:99px;background:#263650;color:#d6e1f4;white-space:nowrap}
.role-swatch{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:7px}
input,select{background:#0b1526;border:1px solid var(--line);color:var(--text);padding:10px;border-radius:8px;min-width:0}
input{width:100%}.search{max-width:320px}.row{display:flex;gap:8px;flex-wrap:wrap}.row>*{flex:1}
.status{font-weight:800}.status.on{color:var(--green)}.status.off{color:var(--red)}
.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
.notice{padding:10px 12px;border-radius:8px;background:#17243a;color:#b9c8df;margin:10px 0}
.empty{color:var(--muted);padding:18px;text-align:center}.small{font-size:11px;color:var(--muted)}
@media(max-width:900px){.grid{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:560px){header{padding:0 14px}main{padding:15px}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.welcome{align-items:flex-start;flex-direction:column}.form-grid{grid-template-columns:1fr}.user{font-size:12px}}
</style></head><body>
<header><div class="brand">GFX <span>ANTIRAID</span></div><div class="user"><span>Signed in as ${escapeHtml(displayName)}</span><form action="/logout" method="POST"><button class="secondary">Log out</button></form></div></header>
<main>
<div class="welcome"><div><h1 id="guildName">Server Control Panel</h1><div class="muted">Channels, roles, member presence and moderation controls</div></div><div class="row" style="flex:0 0 auto"><button class="secondary" id="refreshBtn">Refresh data</button></div></div>
<div class="stats">
<div class="card"><div class="stat-label">TOTAL MEMBERS</div><div class="stat-value" id="memberCount">—</div></div>
<div class="card"><div class="stat-label">ONLINE MEMBERS</div><div class="stat-value" id="onlineCount">—</div></div>
<div class="card"><div class="stat-label">CHANNELS</div><div class="stat-value" id="channelCount">—</div></div>
<div class="card"><div class="stat-label">SERVER ROLES</div><div class="stat-value" id="roleCount">—</div></div>
</div>
<div class="section">
<div class="section-head"><div><h2>Antiraid protection</h2><div class="small">Toggle automatic protection for the configured server</div></div><div><span id="raidStatus" class="status off">OFF</span> <button id="raidToggle">Enable</button></div></div>
<div class="small">Automatic rules: channel create/delete bursts, message spam, ban bursts and kick bursts. Use the logs to review actions.</div>
</div>
<div class="grid">
<div>
<div class="section"><div class="section-head"><h2>Server channels</h2><span class="pill" id="channelTotal">0</span></div><div id="channels" class="list"><div class="empty">Loading…</div></div></div>
<div class="section"><div class="section-head"><h2>Server roles</h2><span class="pill" id="roleTotal">0</span></div><div id="roles" class="list"><div class="empty">Loading…</div></div></div>
</div>
<div>
<div class="section"><div class="section-head"><h2>Online members</h2><span class="pill" id="onlineTotal">0</span></div><input class="search" id="memberSearch" placeholder="Search members…"><div id="members" class="list" style="margin-top:10px"><div class="empty">Loading…</div></div></div>
<div class="section"><div class="section-head"><h2>Authorized Staff</h2><span class="pill" id="managerTotal">0</span></div><div id="managers" class="list"><div class="empty">Loading…</div></div></div>
</div>
</div>
<div class="section">
<div class="section-head"><h2>Moderation commands</h2><span class="small">Actions are checked against Discord permissions and role hierarchy</span></div>
<div class="form-grid">
<div><label class="small">Target user ID</label><input id="targetId" placeholder="Discord user ID"></div>
<div><label class="small">Action</label><select id="action"><option value="kick">Kick member</option><option value="ban">Ban member</option><option value="timeout">Timeout member</option><option value="untimeout">Remove timeout</option><option value="addrole">Add role</option><option value="removerole">Remove role</option></select></div>
<div id="roleField" style="display:none"><label class="small">Role</label><select id="roleSelect"></select></div>
<div id="durationField" style="display:none"><label class="small">Timeout duration (minutes)</label><input id="duration" type="number" min="1" max="40320" value="10"></div>
<div style="grid-column:1/-1"><label class="small">Reason (optional)</label><input id="reason" maxlength="400" placeholder="Reason for this action"></div>
</div>
<div class="row" style="margin-top:12px"><button id="executeBtn">Execute command</button></div>
<div id="commandResult" class="notice" style="display:none" aria-live="polite"></div>
</div>
<div class="section"><div class="section-head"><h2>Recent moderation logs</h2><button class="secondary" id="logsRefresh">Refresh logs</button></div><div id="logs" class="list"><div class="empty">No logs loaded.</div></div></div>
<div class="small">Presence data requires the Discord Presence Intent. Offline members may appear offline when Discord does not provide a cached presence.</div>
</main>
<script>
const $ = id => document.getElementById(id);
let dashboardData = null;
let selectedMembers = [];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[ch]));
}
function statusLabel(status) {
  return ({online:"Online",idle:"Idle",dnd:"Do Not Disturb",offline:"Offline"})[status] || "Offline";
}
function memberRow(member) {
  return '<div class="item"><div class="item-main"><img class="avatar" src="' + esc(member.avatar) + '" alt=""><div style="min-width:0"><div class="item-name">' + esc(member.displayName) + '</div><div class="sub">@' + esc(member.username) + ' · ' + esc(member.highestRole) + '</div></div></div><span class="pill"><i class="dot ' + esc(member.status) + '"></i>' + statusLabel(member.status) + '</span></div>';
}
function renderMembers() {
  const query = $("memberSearch").value.toLowerCase();
  const filtered = selectedMembers.filter(m =>
    (m.displayName + " " + m.username + " " + m.id).toLowerCase().includes(query)
  );
  $("members").innerHTML = filtered.length ? filtered.map(memberRow).join("") : '<div class="empty">No matching members.</div>';
}
function render(data) {
  dashboardData = data;
  $("guildName").textContent = data.guild.name;
  $("memberCount").textContent = data.guild.memberCount;
  $("onlineCount").textContent = data.guild.onlineCount;
  $("channelCount").textContent = data.guild.channelCount;
  $("roleCount").textContent = data.guild.roleCount;
  $("channelTotal").textContent = data.channels.length;
  $("roleTotal").textContent = data.roles.length;
  $("onlineTotal").textContent = data.guild.onlineCount;
  $("managerTotal").textContent = data.raidManagers.length;

  $("raidStatus").textContent = data.antiraidEnabled ? "ON" : "OFF";
  $("raidStatus").className = "status " + (data.antiraidEnabled ? "on" : "off");
  $("raidToggle").textContent = data.antiraidEnabled ? "Disable" : "Enable";
  $("raidToggle").className = data.antiraidEnabled ? "danger" : "";

  $("channels").innerHTML = data.channels.length ? data.channels.map(ch =>
    '<div class="item"><div><div class="item-name"># ' + esc(ch.name) + '</div><div class="sub">' + esc(ch.type) + (ch.parentName ? ' · ' + esc(ch.parentName) : '') + '</div></div><span class="pill">Position ' + ch.position + '</span></div>'
  ).join("") : '<div class="empty">No channels found.</div>';

  $("roles").innerHTML = data.roles.map(role =>
    '<div class="item"><div><div class="item-name"><i class="role-swatch" style="background:' + esc(role.color) + '"></i>' + esc(role.name) + '</div><div class="sub">' + role.memberCount + ' members · ' + (role.managed ? 'Managed' : 'Role') + '</div></div><span class="pill">Position ' + role.position + '</span></div>'
  ).join("");

  selectedMembers = data.members.filter(member => ["online","idle","dnd"].includes(member.status));
  renderMembers();

  $("managers").innerHTML = data.raidManagers.length ? data.raidManagers.map(memberRow).join("") : '<div class="empty">No members currently have an authorized staff role.</div>';

  const currentRole = $("roleSelect").value;
  $("roleSelect").innerHTML = '<option value="">Select a role</option>' + data.roles
    .filter(role => !role.everyone && !role.managed)
    .map(role => '<option value="' + esc(role.id) + '">' + esc(role.name) + ' (position ' + role.position + ')</option>')
    .join("");
  if (currentRole) $("roleSelect").value = currentRole;
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {"Content-Type":"application/json", ...(options.headers || {})},
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
}
async function loadDashboard() {
  $("refreshBtn").disabled = true;
  try {
    const data = await api("/api/overview");
    render(data);
    await loadLogs();
  } catch (error) {
    showResult(error.message, true);
  } finally {
    $("refreshBtn").disabled = false;
  }
}
async function loadLogs() {
  try {
    const data = await api("/api/logs");
    $("logs").innerHTML = data.logs.length ? data.logs.map(log =>
      '<div class="item"><div><div class="item-name">' + esc(log.action) + '</div><div class="sub">Target ' + esc(log.userId) + ' · Moderator ' + esc(log.moderatorId) + '</div></div><span class="small">' + esc(new Date(log.timestamp).toLocaleString()) + '</span></div>'
    ).join("") : '<div class="empty">No moderation actions recorded in this process yet.</div>';
  } catch (error) {
    $("logs").innerHTML = '<div class="empty">' + esc(error.message) + '</div>';
  }
}
function showResult(message, isError = false) {
  $("commandResult").style.display = "block";
  $("commandResult").textContent = message;
  $("commandResult").style.border = isError ? "1px solid #a83d50" : "1px solid #286c55";
}
function updateActionFields() {
  const action = $("action").value;
  $("roleField").style.display = ["addrole","removerole"].includes(action) ? "block" : "none";
  $("durationField").style.display = action === "timeout" ? "block" : "none";
}
$("action").addEventListener("change", updateActionFields);
$("memberSearch").addEventListener("input", renderMembers);
$("refreshBtn").addEventListener("click", loadDashboard);
$("logsRefresh").addEventListener("click", loadLogs);
$("raidToggle").addEventListener("click", async () => {
  $("raidToggle").disabled = true;
  try {
    const result = await api("/api/antiraid", {method:"POST", body:JSON.stringify({enabled:!dashboardData.antiraidEnabled})});
    showResult(result.message);
    await loadDashboard();
  } catch (error) { showResult(error.message, true); }
  finally { $("raidToggle").disabled = false; }
});
$("executeBtn").addEventListener("click", async () => {
  const payload = {
    userId: $("targetId").value.trim(),
    action: $("action").value,
    roleId: $("roleSelect").value,
    duration: Number($("duration").value),
    reason: $("reason").value.trim()
  };
  $("executeBtn").disabled = true;
  try {
    const result = await api("/api/command", {method:"POST", body:JSON.stringify(payload)});
    showResult(result.message);
    await loadDashboard();
  } catch (error) { showResult(error.message, true); }
  finally { $("executeBtn").disabled = false; }
});
updateActionFields();
loadDashboard();
setInterval(loadDashboard, 60000);
</script></body></html>`);
});
// Escape server-side text inserted into the HTML document.
function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]));
}

// -------------------------------
// Dashboard API
// -------------------------------
app.get("/api/overview", requireRaidManager, async (req, res) => {
    try {
        res.json(await fetchGuildData());
    } catch (error) {
        console.error("Overview error:", error);
        res.status(500).json({ error: error.message || "Could not load server information." });
    }
});

app.get("/api/logs", requireRaidManager, (req, res) => {
    const logs = [];
    for (const [userId, entries] of modLogs.entries()) {
        for (const entry of entries) logs.push({ userId, ...entry });
    }
    logs.sort((a, b) => b.timestamp - a.timestamp);
    res.json({ logs: logs.slice(0, 100) });
});

app.post("/api/antiraid", requireRaidManager, (req, res) => {
    if (typeof req.body.enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be true or false." });
    }
    antiraidEnabled = req.body.enabled;
    addModLog(req.user.id, `Antiraid protection ${antiraidEnabled ? "enabled" : "disabled"} from panel`, req.user.id);
    res.json({ ok: true, enabled: antiraidEnabled, message: `Antiraid protection ${antiraidEnabled ? "enabled" : "disabled"}.` });
});

app.post(
    "/api/command",
    requireRaidManager,
    async (req, res) => {
        const { userId, action, roleId, duration, reason } = req.body || {};
        if (typeof userId !== "string" || !/^\d{17,20}$/.test(userId)) {
            return res.status(400).json({ error: "Enter a valid Discord user ID." });
        }

        const allowedActions = ["kick", "ban", "timeout", "untimeout", "addrole", "removerole"];
        if (!allowedActions.includes(action)) {
            return res.status(400).json({ error: "Unknown moderation command." });
        }

        try {
            const guild = req.guild;
            const actor = req.guildMember;
            const target = await guild.members.fetch(userId).catch(() => null);
            if (!target) return res.status(404).json({ error: "That user is not a member of this server." });
            if (!canModerateTarget(guild, actor, target)) {
                return res.status(403).json({ error: "Role hierarchy prevents you from moderating this member." });
            }

            const cleanReason = (typeof reason === "string" && reason.trim())
                ? reason.trim().slice(0, 400)
                : `Panel action by ${req.user.username || req.user.id}`;

            if (action === "kick") {
                if (!hasPermission(actor, PermissionFlagsBits.KickMembers) ||
                    !hasPermission(guild.members.me, PermissionFlagsBits.KickMembers)) {
                    return res.status(403).json({ error: "Kick Members permission is required for you and the bot." });
                }
                await target.kick(cleanReason);
            } else if (action === "ban") {
                if (!hasPermission(actor, PermissionFlagsBits.BanMembers) ||
                    !hasPermission(guild.members.me, PermissionFlagsBits.BanMembers)) {
                    return res.status(403).json({ error: "Ban Members permission is required for you and the bot." });
                }
                await target.ban({ reason: cleanReason });
            } else if (action === "timeout") {
                if (!hasPermission(actor, PermissionFlagsBits.ModerateMembers) ||
                    !hasPermission(guild.members.me, PermissionFlagsBits.ModerateMembers)) {
                    return res.status(403).json({ error: "Moderate Members permission is required for you and the bot." });
                }
                const minutes = Number(duration);
                if (!Number.isInteger(minutes) || minutes < 1 || minutes > 40320) {
                    return res.status(400).json({ error: "Timeout must be between 1 and 40320 minutes." });
                }
                await target.timeout(minutes * 60 * 1000, cleanReason);
            } else if (action === "untimeout") {
                if (!hasPermission(actor, PermissionFlagsBits.ModerateMembers) ||
                    !hasPermission(guild.members.me, PermissionFlagsBits.ModerateMembers)) {
                    return res.status(403).json({ error: "Moderate Members permission is required for you and the bot." });
                }
                await target.timeout(null, cleanReason);
            } else {
                if (!hasPermission(actor, PermissionFlagsBits.ManageRoles) ||
                    !hasPermission(guild.members.me, PermissionFlagsBits.ManageRoles)) {
                    return res.status(403).json({ error: "Manage Roles permission is required for you and the bot." });
                }
                if (typeof roleId !== "string" || !/^\d{17,20}$/.test(roleId)) {
                    return res.status(400).json({ error: "Select a valid role." });
                }
                const role = await guild.roles.fetch(roleId).catch(() => null);
                if (!role || !roleIsManageable(guild, actor, target, role)) {
                    return res.status(403).json({ error: "That role cannot be managed due to role hierarchy or role type." });
                }
                if (action === "addrole") {
                    await target.roles.add(role, cleanReason);
                } else {
                    await target.roles.remove(role, cleanReason);
                }
            }

            const descriptions = {
                kick: "Kicked member",
                ban: "Banned member",
                timeout: `Timed out member for ${duration} minute(s)`,
                untimeout: "Removed member timeout",
                addrole: "Added role",
                removerole: "Removed role"
            };
            const detail = ["addrole", "removerole"].includes(action)
                ? `${descriptions[action]} ${guild.roles.cache.get(roleId)?.name || roleId}`
                : descriptions[action];

            addModLog(userId, `${detail}. Reason: ${cleanReason}`, req.user.id);
            return res.json({ ok: true, message: `${detail} successfully.` });
        } catch (error) {
            console.error("Panel command failed:", error);
            return res.status(500).json({ error: "Discord rejected the command. Check bot permissions, hierarchy, and the target member." });
        }
    }
);

// -------------------------------
// Antiraid tracking
// -------------------------------
const channelCreateLog = new Map();
const channelDeleteLog = new Map();
const messageLog = new Map();
const banLog = new Map();
const kickLog = new Map();

function addRecent(map, userId, now, windowMs) {
    const entries = map.get(userId) || [];
    entries.push(now);
    const recent = entries.filter(timestamp => now - timestamp < windowMs);
    map.set(userId, recent);
    return recent.length;
}

async function banForRaid(guild, userId, reason, logText) {
    try {
        const member = await guild.members.fetch(userId);
        // Never automatically punish the server owner or an authorized staff member.
        if (userId === guild.ownerId || isAuthorizedStaff(member) ||
            hasPermission(member, PermissionFlagsBits.Administrator)) return;
        if (!member.bannable) return;
        await member.ban({ reason });
        addModLog(userId, logText);
    } catch (error) {
        console.error(`Antiraid action failed for ${userId}:`, error.message);
    }
}

bot.on("channelCreate", async channel => {
    if (!antiraidEnabled || !channel.guild || channel.guild.id !== PRIMARY_GUILD_ID) return;
    try {
        const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelCreate, limit: 5 });
        const entry = logs.entries.find(item => item.target?.id === channel.id);
        if (!entry?.executor || entry.executor.id === bot.user.id) return;
        if (addRecent(channelCreateLog, entry.executor.id, Date.now(), 300000) >= 3) {
            await banForRaid(channel.guild, entry.executor.id, "Antiraid: channel creation spam", "Antiraid auto-ban (channel creation spam)");
        }
    } catch (error) {
        console.error("Channel-create antiraid check failed:", error.message);
    }
});

bot.on("channelDelete", async channel => {
    if (!antiraidEnabled || !channel.guild || channel.guild.id !== PRIMARY_GUILD_ID) return;
    try {
        const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 5 });
        const entry = logs.entries.find(item => item.target?.id === channel.id);
        if (!entry?.executor || entry.executor.id === bot.user.id) return;
        if (addRecent(channelDeleteLog, entry.executor.id, Date.now(), 300000) >= 3) {
            await banForRaid(channel.guild, entry.executor.id, "Antiraid: channel deletion spam", "Antiraid auto-ban (channel deletion spam)");
        }
    } catch (error) {
        console.error("Channel-delete antiraid check failed:", error.message);
    }
});

bot.on("messageCreate", async message => {
    if (!antiraidEnabled || !message.guild || message.guild.id !== PRIMARY_GUILD_ID || message.author.bot) return;
    if (addRecent(messageLog, message.author.id, Date.now(), 15000) > 10) {
        await banForRaid(message.guild, message.author.id, "Antiraid: message spam", "Antiraid auto-ban (message spam)");
    }
});

bot.on("guildBanAdd", async ban => {
    if (!antiraidEnabled || ban.guild.id !== PRIMARY_GUILD_ID) return;
    try {
        const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 5 });
        const entry = logs.entries.find(item => item.target?.id === ban.user.id);
        if (!entry?.executor || entry.executor.id === bot.user.id) return;
        const actingMember = await ban.guild.members.fetch(entry.executor.id).catch(() => null);
        if (actingMember && (isAuthorizedStaff(actingMember) ||
            hasPermission(actingMember, PermissionFlagsBits.Administrator))) return;
        if (addRecent(banLog, entry.executor.id, Date.now(), 300000) > 3) {
            const actor = await ban.guild.members.fetch(entry.executor.id).catch(() => null);
            if (actor?.kickable) {
                await actor.kick("Antiraid: ban spam");
                addModLog(actor.id, "Antiraid auto-kick (ban spam)");
            }
        }
    } catch (error) {
        console.error("Ban-spam antiraid check failed:", error.message);
    }
});

bot.on("guildMemberRemove", async member => {
    if (!antiraidEnabled || member.guild.id !== PRIMARY_GUILD_ID) return;
    try {
        const logs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 5 });
        const entry = logs.entries.find(item =>
            item.target?.id === member.id &&
            Date.now() - item.createdTimestamp < 15000
        );
        if (!entry?.executor || entry.executor.id === bot.user.id) return;
        const actingMember = await member.guild.members.fetch(entry.executor.id).catch(() => null);
        if (actingMember && (isAuthorizedStaff(actingMember) ||
            hasPermission(actingMember, PermissionFlagsBits.Administrator))) return;
        if (addRecent(kickLog, entry.executor.id, Date.now(), 300000) > 5) {
            const actor = await member.guild.members.fetch(entry.executor.id).catch(() => null);
            if (actor?.kickable) {
                await actor.kick("Antiraid: kick spam");
                addModLog(actor.id, "Antiraid auto-kick (kick spam)");
            }
        }
    } catch (error) {
        console.error("Kick-spam antiraid check failed:", error.message);
    }
});

// -------------------------------
// Start
// -------------------------------
bot.login(process.env.BOT_TOKEN).catch(error => {
    console.error("Discord bot login failed:", error);
});

app.listen(PORT, () => {
    console.log(`GFX Antiraid dashboard running on port ${PORT}`);
});


// ======================================================
// GFX ANTIRAID — EMBED ECONOMY SYSTEM
// ======================================================

const fs = require("fs");
const path = require("path");
const { EmbedBuilder } = require("discord.js");

const economyFile = path.join(__dirname, "economy-data.json");

const economy = {
    users: {},
    bannedUsers: {}
};

// Load saved economy data.
// Supports the old users-only format and the newer format.
if (fs.existsSync(economyFile)) {
    try {
        const savedData = JSON.parse(
            fs.readFileSync(economyFile, "utf8")
        );

        if (savedData && typeof savedData === "object") {
            if (
                savedData.users &&
                typeof savedData.users === "object"
            ) {
                economy.users = savedData.users;
                economy.bannedUsers =
                    savedData.bannedUsers || {};
            } else {
                // Compatibility with older economy files.
                economy.users = savedData;
                economy.bannedUsers = {};
            }
        }
    } catch (error) {
        console.error(
            "[GFX Economy] Economy data could not load:",
            error
        );
    }
}

// Save economy data
function saveEconomy() {
    fs.writeFileSync(
        economyFile,
        JSON.stringify(economy, null, 2)
    );
}

// Economy settings
const ECONOMY_STARTING_BALANCE = 500;
const ECONOMY_CURRENCY = "GFX Coins";

const economyCooldowns = new Map();

const shopItems = {
    fishing_rod: {
        name: "Fishing Rod",
        price: 500,
        description: "Improves your fishing equipment."
    },
    laptop: {
        name: "Laptop",
        price: 1500,
        description: "A valuable personal computer."
    },
    diamond: {
        name: "Diamond",
        price: 5000,
        description: "A rare and valuable diamond."
    },
    gold: {
        name: "Gold Bar",
        price: 2500,
        description: "A shiny gold bar."
    },
    protection: {
        name: "Rob Protection",
        price: 3000,
        description: "A collectible protection item."
    }
};

// Get or create user account
function getEconomyUser(userId) {
    if (!economy.users[userId]) {
        economy.users[userId] = {
            wallet: ECONOMY_STARTING_BALANCE,
            bank: 0,
            inventory: {},
            daily: 0,
            cooldowns: {}
        };

        saveEconomy();
    }

    const user = economy.users[userId];

    user.wallet ??= ECONOMY_STARTING_BALANCE;
    user.bank ??= 0;
    user.inventory ??= {};
    user.cooldowns ??= {};
    user.daily ??= 0;

    return user;
}

// Embed creator
function economyEmbed(
    title,
    description,
    color = 0x5865F2
) {
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description)
        .setFooter({
            text: "GFX Economy System"
        })
        .setTimestamp();
}

// Cooldown checker
function economyCooldown(user, command, seconds) {
    const now = Date.now();
    const previous = user.cooldowns[command] || 0;

    if (now - previous < seconds * 1000) {
        return Math.ceil(
            (seconds * 1000 - (now - previous)) / 1000
        );
    }

    user.cooldowns[command] = now;
    return 0;
}

// Amount parser
function parseAmount(value, maximum) {
    if (!value) return null;

    if (value.toLowerCase() === "all") {
        return maximum;
    }

    const amount = Number(value);

    if (!Number.isSafeInteger(amount) || amount <= 0) {
        return null;
    }

    return amount;
}

// Blackjack card system
function blackjackCard() {
    const cards = [
        { name: "A", value: 11 },
        { name: "2", value: 2 },
        { name: "3", value: 3 },
        { name: "4", value: 4 },
        { name: "5", value: 5 },
        { name: "6", value: 6 },
        { name: "7", value: 7 },
        { name: "8", value: 8 },
        { name: "9", value: 9 },
        { name: "10", value: 10 },
        { name: "J", value: 10 },
        { name: "Q", value: 10 },
        { name: "K", value: 10 }
    ];

    return cards[
        Math.floor(Math.random() * cards.length)
    ];
}

function blackjackTotal(hand) {
    let total = hand.reduce(
        (sum, card) => sum + card.value,
        0
    );

    let aces = hand.filter(
        card => card.name === "A"
    ).length;

    while (total > 21 && aces > 0) {
        total -= 10;
        aces--;
    }

    return total;
}

// ======================================================
// ECONOMY COMMAND HANDLER
// ======================================================

bot.on("messageCreate", async message => {
    if (!message.guild || message.author.bot) return;
    if (message.guild.id !== PRIMARY_GUILD_ID) return;

    const prefix = "!";
    if (!message.content.startsWith(prefix)) return;

    const args = message.content
        .slice(prefix.length)
        .trim()
        .split(/\s+/);

    const command = args.shift()?.toLowerCase();

    // Only process economy commands.
    const economyCommands = new Set([
        "economy", "econ",
        "balance", "bal",
        "daily",
        "work",
        "beg",
        "fish",
        "deposit", "dep",
        "withdraw", "with",
        "shop",
        "buy",
        "inventory", "inv",
        "rob",
        "blackjack", "bj",
        "slots",
        "leaderboard", "lb",
        "econban",
        "econunban",
        "econbanlist",
        "add",
        "remove"
    ]);

    if (!economyCommands.has(command)) return;

    try {

        // ==================================================
        // STAFF ECONOMY COMMANDS
        // Uses your existing Raid Manager permission system.
        // ==================================================

        const isEconomyStaff =
            isAuthorizedStaff(message.member);

        // !ECONBAN @USER [REASON]
        if (command === "econban") {
            if (!isEconomyStaff) {
                return message.reply(
                    "❌ You need an authorized staff role to use this command."
                );
            }

            const target = message.mentions.users.first();

            if (
                !target ||
                target.bot
            ) {
                return message.reply(
                    "❌ Usage: `!econban @user [reason]`"
                );
            }

            if (economy.bannedUsers[target.id]) {
                return message.reply(
                    `❌ ${target.tag} is already economy-banned.`
                );
            }

            const reason =
                args.slice(1).join(" ") ||
                "No reason provided.";

            economy.bannedUsers[target.id] = {
                reason: reason.slice(0, 300),
                moderatorId: message.author.id,
                timestamp: Date.now()
            };

            saveEconomy();

            const embed = economyEmbed(
                "🔨 Economy Ban",
                `**User:** ${target.tag}\n` +
                `**User ID:** ${target.id}\n` +
                `**Reason:** ${reason}\n` +
                `**Moderator:** ${message.author.tag}`,
                0xE74C3C
            );

            return message.reply({
                embeds: [embed]
            });
        }

        // !ECONUNBAN @USER
        if (command === "econunban") {
            if (!isEconomyStaff) {
                return message.reply(
                    "❌ You need an authorized staff role to use this command."
                );
            }

            const target = message.mentions.users.first();

            if (!target) {
                return message.reply(
                    "❌ Usage: `!econunban @user`"
                );
            }

            if (!economy.bannedUsers[target.id]) {
                return message.reply(
                    `❌ ${target.tag} is not economy-banned.`
                );
            }

            delete economy.bannedUsers[target.id];

            saveEconomy();

            const embed = economyEmbed(
                "✅ Economy Ban Removed",
                `**User:** ${target.tag}\n` +
                `**User ID:** ${target.id}\n` +
                `**Moderator:** ${message.author.tag}`,
                0x2ECC71
            );

            return message.reply({
                embeds: [embed]
            });
        }

        // !ECONBANLIST
        if (command === "econbanlist") {
            if (!isEconomyStaff) {
                return message.reply(
                    "❌ You need an authorized staff role to use this command."
                );
            }

            const entries = Object.entries(
                economy.bannedUsers
            );

            if (!entries.length) {
                return message.reply({
                    embeds: [
                        economyEmbed(
                            "📋 Economy Ban List",
                            "There are currently no economy-banned users."
                        )
                    ]
                });
            }

            const list = entries
                .slice(0, 20)
                .map(([id, data], index) =>
                    `**${index + 1}.** <@${id}>\n` +
                    `Reason: ${data.reason || "No reason provided"}`
                )
                .join("\n\n");

            return message.reply({
                embeds: [
                    economyEmbed(
                        "📋 Economy Ban List",
                        list +
                        (
                            entries.length > 20
                                ? `\n\nAnd ${entries.length - 20} more...`
                                : ""
                        )
                    )
                ]
            });
        }

        // !ADD @USER AMOUNT
        if (command === "add") {
            if (!isEconomyStaff) {
                return message.reply(
                    "❌ You need an authorized staff role to use this command."
                );
            }

            const target = message.mentions.users.first();
            const amount = Number(args[1]);

            if (
                !target ||
                target.bot ||
                !Number.isSafeInteger(amount) ||
                amount <= 0
            ) {
                return message.reply(
                    "❌ Usage: `!add @user amount`"
                );
            }

            const targetData = getEconomyUser(target.id);

            if (
                !Number.isSafeInteger(
                    targetData.wallet + amount
                )
            ) {
                return message.reply(
                    "❌ That amount is too large."
                );
            }

            targetData.wallet += amount;

            saveEconomy();

            return message.reply({
                embeds: [
                    economyEmbed(
                        "💰 GFX Coins Added",
                        `**User:** ${target.tag}\n` +
                        `**Added:** ${amount.toLocaleString()} GFX Coins\n` +
                        `**New Wallet:** ${targetData.wallet.toLocaleString()} GFX Coins\n` +
                        `**Moderator:** ${message.author.tag}`,
                        0x2ECC71
                    )
                ]
            });
        }

        // !REMOVE @USER AMOUNT
        if (command === "remove") {
            if (!isEconomyStaff) {
                return message.reply(
                    "❌ You need an authorized staff role to use this command."
                );
            }

            const target = message.mentions.users.first();
            const amount = Number(args[1]);

            if (
                !target ||
                target.bot ||
                !Number.isSafeInteger(amount) ||
                amount <= 0
            ) {
                return message.reply(
                    "❌ Usage: `!remove @user amount`"
                );
            }

            const targetData = getEconomyUser(target.id);

            const totalMoney =
                targetData.wallet + targetData.bank;

            if (totalMoney < amount) {
                return message.reply(
                    `❌ ${target.tag} only has ${totalMoney.toLocaleString()} GFX Coins in total.`
                );
            }

            // Remove from wallet first, then bank.
            const fromWallet = Math.min(
                targetData.wallet,
                amount
            );

            const fromBank = amount - fromWallet;

            targetData.wallet -= fromWallet;
            targetData.bank -= fromBank;

            saveEconomy();

            return message.reply({
                embeds: [
                    economyEmbed(
                        "💸 GFX Coins Removed",
                        `**User:** ${target.tag}\n` +
                        `**Removed:** ${amount.toLocaleString()} GFX Coins\n` +
                        `**Wallet Removed:** ${fromWallet.toLocaleString()}\n` +
                        `**Bank Removed:** ${fromBank.toLocaleString()}\n` +
                        `**Moderator:** ${message.author.tag}`,
                        0xE74C3C
                    )
                ]
            });
        }

        // ==================================================
        // ECONOMY BAN CHECK
        // ==================================================

        if (economy.bannedUsers[message.author.id]) {
            const ban =
                economy.bannedUsers[message.author.id];

            return message.reply({
                embeds: [
                    economyEmbed(
                        "🚫 Economy Access Denied",
                        `You are banned from using the GFX Economy system.\n\n` +
                        `**Reason:** ${ban.reason || "No reason provided"}\n` +
                        `**Moderator ID:** ${ban.moderatorId || "Unknown"}\n\n` +
                        `Contact an authorized staff member if you believe this is a mistake.`,
                        0xE74C3C
                    )
                ]
            });
        }

        // Create/load account after staff commands
        // and the economy-ban check.
        const user = getEconomyUser(message.author.id);

        // ==================================================
        // !ECONOMY
        // ==================================================

        if (command === "economy" || command === "econ") {

            const embed = economyEmbed(
                "💰 GFX Economy Commands",
                "**MONEY COMMANDS**\n" +
                "`!balance` - View your balance\n" +
                "`!daily` - Collect daily coins\n" +
                "`!work` - Earn money working\n" +
                "`!beg` - Beg for money\n" +
                "`!deposit <amount>` - Deposit money\n" +
                "`!withdraw <amount>` - Withdraw money\n\n" +

                "**ACTIVITIES**\n" +
                "`!fish` - Go fishing\n" +
                "`!rob @user` - Attempt a robbery\n" +
                "`!blackjack <bet>` - Play blackjack\n" +
                "`!slots <bet>` - Play slots\n\n" +

                "**SHOP**\n" +
                "`!shop` - Browse the shop\n" +
                "`!buy <item>` - Purchase an item\n" +
                "`!inventory` - View your inventory\n\n" +

                "**OTHER**\n" +
                "`!leaderboard` - Richest members\n\n" +

                "**STAFF ECONOMY COMMANDS**\n" +
                "`!econban @user [reason]` - Economy-ban a user\n" +
                "`!econunban @user` - Remove an economy ban\n" +
                "`!econbanlist` - View economy bans\n" +
                "`!add @user amount` - Add GFX Coins\n" +
                "`!remove @user amount` - Remove GFX Coins"
            );

            return message.reply({
                embeds: [embed]
            });
        }

        // ==================================================
        // !BALANCE
        // ==================================================

        if (command === "balance" || command === "bal") {

            const target =
                message.mentions.users.first() ||
                message.author;

            const targetData =
                getEconomyUser(target.id);

            const embed = economyEmbed(
                "💰 Account Balance",
                `**${target.username}'s Account**\n\n` +
                `💵 Wallet: **${targetData.wallet.toLocaleString()}** ${ECONOMY_CURRENCY}\n` +
                `🏦 Bank: **${targetData.bank.toLocaleString()}** ${ECONOMY_CURRENCY}\n\n` +
                `💎 Total Net Worth: **${(targetData.wallet + targetData.bank).toLocaleString()}** ${ECONOMY_CURRENCY}`
            );

            return message.reply({
                embeds: [embed]
            });
        }

        // ==================================================
        // !DAILY
        // ==================================================

        if (command === "daily") {

            const remaining = economyCooldown(
                user,
                "daily",
                86400
            );

            if (remaining) {
                return message.reply({
                    embeds: [
                        economyEmbed(
                            "⏰ Daily Reward",
                            `You already collected your daily reward!\nCome back in **${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m**.`
                        )
                    ]
                });
            }

            const reward = 500;

            user.wallet += reward;

            saveEconomy();

            return message.reply({
                embeds: [
                    economyEmbed(
                        "🎁 Daily Reward",
                        `You collected **${reward} GFX Coins**!\n\nYour new balance is **${user.wallet.toLocaleString()}**.`,
                        0x2ECC71
                    )
                ]
            });
        }

        // ==================================================
        // !WORK
        // ==================================================

        if (command === "work") {

            const remaining = economyCooldown(
                user,
                "work",
                60
            );

            if (remaining) {
                return message.reply({
                    embeds: [
                        economyEmbed(
                            "⏰ Work Cooldown",
                            `You need to wait **${remaining} seconds** before working again.`
                        )
                    ]
                });
            }

            const jobs = [
                "worked as a security guard",
                "delivered packages",
                "worked at a restaurant",
                "completed a construction job",
                "worked as a mechanic",
                "completed a delivery route"
            ];

            const reward =
                Math.floor(Math.random() * 151) + 100;

            const job =
                jobs[Math.floor(Math.random() * jobs.length)];

            user.wallet += reward;

            saveEconomy();

            return message.reply({
                embeds: [
                    economyEmbed(
                        "💼 Work Completed",
                        `You ${job}!\n\nYou earned **${reward} GFX Coins**.`,
                        0x2ECC71
                    )
                ]
            });
        }

        // ==================================================
        // !BEG
        // ==================================================

        if (command === "beg") {

            const remaining = economyCooldown(
                user,
                "beg",
                20
            );

            if (remaining) {
                return message.reply({
                    embeds: [
                        economyEmbed(
                            "⏰ Beg Cooldown",
                            `Try again in **${remaining} seconds**.`
                        )
                    ]
                });
            }

            const reward =
                Math.floor(Math.random() * 51) + 10;

            user.wallet += reward;

            saveEconomy();

            return message.reply({
                embeds: [
                    economyEmbed(
                        "🥺 Someone Helped You!",
                        `A generous stranger gave you **${reward} GFX Coins**!`,
                        0x2ECC71
                    )
                ]
            });
        }

        // ==================================================
        // !FISH
        // ==================================================

        if (command === "fish") {

            const remaining = economyCooldown(
                user,
                "fish",
                30
            );

            if (remaining) {
                return message.reply({
                    embeds: [
                        economyEmbed(
                            "🎣 Fishing Cooldown",
                            `You can fish again in **${remaining} seconds**.`
                        )
                    ]
                });
            }

            const fishTypes = [
                { name: "Common Fish", reward: 50 },
                { name: "Salmon", reward: 100 },
                { name: "Tuna", reward: 150 },
                { name: "Golden Fish", reward: 300 },
                { name: "Rare Shark", reward: 500 }
            ];

            const caught = fishTypes[
                Math.floor(Math.random() * fishTypes.length)
            ];

            user.wallet += caught.reward;

            saveEconomy();

            return message.reply({
                embeds: [
                    economyEmbed(
                        "🎣 Fishing Results",
                        `You went fishing and caught a **${caught.name}**!\n\n` +
                        `💰 Earnings: **${caught.reward} GFX Coins**`,
                        0x3498DB
                    )
                ]
            });
        }

        // ==================================================
        // !DEPOSIT
        // ==================================================

        if (command === "deposit" || command === "dep") {

            const amount = parseAmount(
                args[0],
                user.wallet
            );

            if (!amount || amount > user.wallet) {
                return message.reply({
                    embeds: [
                        economyEmbed(
                            "❌ Invalid Amount",
                            "You don't have enough money in your wallet."
                        )
                    ]
                });
            }

            user.wallet -= amount;
            user.bank += amount;

            saveEconomy();

            return message.reply({
                embeds: [
                    economyEmbed(
                        "🏦 Deposit Successful",
                        `Deposited **${amount.toLocaleString()} GFX Coins** into your bank.`
                    )
                ]
            });
        }

        // ==================================================
        // !WITHDRAW
        // ==================================================

        if (command === "withdraw" || command === "with") {

            const amount = parseAmount(
                args[0],
                user.bank
            );

            if (!amount || amount > user.bank) {
                return message.reply({
                    embeds: [
                        economyEmbed(
                            "❌ Invalid Amount",
                            "You don't have enough money in your bank."
                        )
                    ]
                });
            }

            user.bank -= amount;
            user.wallet += amount;

            saveEconomy();

            return message.reply({
                embeds: [
                    economyEmbed(
                        "🏦 Withdrawal Successful",
                        `Withdrew **${amount.toLocaleString()} GFX Coins**.`
                    )
                ]
            });
        }

        // ==================================================
        // !SHOP
        // ==================================================

        if (command === "shop") {

            const embed = economyEmbed(
                "🛒 GFX Item Shop",
                Object.entries(shopItems)
                    .map(([id, item]) =>
                        `**${item.name}**\n` +
                        `${item.description}\n` +
                        `💰 Price: **${item.price.toLocaleString()}**\n` +
                        `Item ID: \`${id}\``
                    )
                    .join("\n\n")
            );

            embed.addFields({
                name: "How to purchase",
                value: "`!buy fishing_rod`\n`!buy diamond`"
            });

            return message.reply({
                embeds: [embed]
            });
        }

        // ==================================================
        // !BUY
        // ==================================================

        if (command === "buy") {

            const itemId = args[0]?.toLowerCase();
            const item = shopItems[itemId];

            if (!item) {
                return message.reply({
                    embeds: [
                        economyEmbed(
                            "❌ Item Not Found",
                            "Use `!shop` to see available items."
                        )
                    ]
                });
            }

            if (user.wallet < item.price) {
                return message.reply({
                    embeds: [
                        economyEmbed(
                            "❌ Insufficient Funds",
                            `You need **${item.price - user.wallet} more coins** to purchase this item.`
                        )
                    ]
                });
            }

            user.wallet -= item.price;

            user.inventory[itemId] =
                (user.inventory[itemId] || 0) + 1;

            saveEconomy();

            return message.reply({
                embeds: [
                    economyEmbed(
                        "✅ Purchase Successful",
                        `You purchased **${item.name}**!\n\n` +
                        `Remaining wallet: **${user.wallet.toLocaleString()}**`
                    )
                ]
            });
        }

        // ==================================================
        // !INVENTORY
        // ==================================================

        if (command === "inventory" || command === "inv") {

            const items = Object.entries(user.inventory)
                .filter(([, quantity]) => quantity > 0)
                .map(([id, quantity]) =>
                    `📦 **${shopItems[id]?.name || id}** x${quantity}`
                );

            return message.reply({
                embeds: [
                    economyEmbed(
                        "🎒 Your Inventory",
                        items.length
                            ? items.join("\n")
                            : "Your inventory is empty."
                    )
                ]
            });
        }

        // ==================================================
        // !ROB
        // ==================================================

        if (command === "rob") {

            const target =
                message.mentions.users.first();

            if (
                !target ||
                target.id === message.author.id ||
                target.bot
            ) {
                return message.reply({
                    embeds: [
                        economyEmbed(
                            "❌ Invalid Target",
                            "Mention someone you want to rob."
                        )
                    ]
                });
            }

            const remaining = economyCooldown(
                user,
                "rob",
                1
            );

            if (remaining) {
                return message.reply({
                    embeds: [
                        economyEmbed(
                            "⏰ Robbery Cooldown",
                            `You can rob again in **${remaining} seconds**.`
                        )
                    ]
                });
            }

            const victim = getEconomyUser(target.id);

            if (victim.wallet < 50) {
                return message.reply({
                    embeds: [
                        economyEmbed(
                            "❌ Robbery Failed",
                            "That person doesn't have enough money to rob."
                        )
                    ]
                });
            }

            if (Math.random() < 0.45) {

                const stolen = Math.min(
                    victim.wallet,
                    Math.floor(Math.random() * 201) + 50
                );

                victim.wallet -= stolen;
                user.wallet += stolen;

                saveEconomy();

                return message.reply({
                    embeds: [
                        economyEmbed(
                            "💰 Robbery Successful!",
                            `You successfully robbed ${target}!\n\n` +
                            `You stole **${stolen} GFX Coins**!`,
                            0x2ECC71
                        )
                    ]
                });
            }

            const fine = Math.min(
                user.wallet,
                Math.floor(Math.random() * 101) + 50
            );

            user.wallet -= fine;

            saveEconomy();

            return message.reply({
                embeds: [
                    economyEmbed(
                        "🚔 You Got Caught!",
                        `You tried to rob ${target}, but got caught!\n\n` +
                        `You paid a **${fine} GFX Coins** fine.`,
                        0xE74C3C
                    )
                ]
            });
        }

        // ==================================================
        // !BLACKJACK
        // Automatic single-round blackjack
        // ==================================================

        if (command === "blackjack" || command === "bj") {

            const bet = parseAmount(
                args[0],
                user.wallet
            );

            if (
                !bet ||
                bet < 10 ||
                bet > user.wallet
            ) {
                return message.reply({
                    embeds: [
                        economyEmbed(
                            "🃏 Blackjack",
                            "Enter a valid bet of at least 10 coins that you can afford.\nExample: `!blackjack 100`"
                        )
                    ]
                });
            }

            const playerHand = [
                blackjackCard(),
                blackjackCard()
            ];

            const dealerHand = [
                blackjackCard(),
                blackjackCard()
            ];

            while (blackjackTotal(playerHand) < 17) {
                playerHand.push(blackjackCard());
            }

            while (blackjackTotal(dealerHand) < 17) {
                dealerHand.push(blackjackCard());
            }

            const playerScore =
                blackjackTotal(playerHand);

            const dealerScore =
                blackjackTotal(dealerHand);

            user.wallet -= bet;

            let result;
            let color = 0x5865F2;

            if (playerScore > 21) {
                result =
                    `💀 You busted and lost **${bet} coins**.`;

                color = 0xE74C3C;

            } else if (
                dealerScore > 21 ||
                playerScore > dealerScore
            ) {
                const winnings = bet * 2;

                user.wallet += winnings;

                result =
                    `🎉 You won **${bet} coins**!`;

                color = 0x2ECC71;

            } else if (playerScore === dealerScore) {
                user.wallet += bet;

                result =
                    "🤝 It's a tie! Your bet was returned.";

            } else {
                result =
                    `😢 Dealer wins! You lost **${bet} coins**.`;

                color = 0xE74C3C;
            }

            saveEconomy();

            const embed = economyEmbed(
                "🃏 Blackjack Results",
                `**Your Cards:** ${playerHand.map(c => c.name).join(", ")}\n` +
                `Score: **${playerScore}**\n\n` +
                `**Dealer Cards:** ${dealerHand.map(c => c.name).join(", ")}\n` +
                `Score: **${dealerScore}**\n\n` +
                `${result}\n\n` +
                `💰 Wallet: **${user.wallet.toLocaleString()} coins**`,
                color
            );

            return message.reply({
                embeds: [embed]
            });
        }

        // ==================================================
        // !SLOTS
        // ==================================================

        if (command === "slots") {

            const bet = parseAmount(
                args[0],
                user.wallet
            );

            if (
                !bet ||
                bet < 10 ||
                bet > user.wallet
            ) {
                return message.reply({
                    embeds: [
                        economyEmbed(
                            "🎰 Slot Machine",
                            "Enter a valid bet of at least 10 coins.\nExample: `!slots 100`"
                        )
                    ]
                });
            }

            const symbols = [
                "🍒",
                "🍋",
                "🍇",
                "💎",
                "7️⃣"
            ];

            const result = [
                symbols[Math.floor(Math.random() * symbols.length)],
                symbols[Math.floor(Math.random() * symbols.length)],
                symbols[Math.floor(Math.random() * symbols.length)]
            ];

            user.wallet -= bet;

            let winnings = 0;

            if (
                result[0] === result[1] &&
                result[1] === result[2]
            ) {
                winnings = bet * 5;

            } else if (
                result[0] === result[1] ||
                result[1] === result[2] ||
                result[0] === result[2]
            ) {
                winnings = bet * 2;
            }

            user.wallet += winnings;

            saveEconomy();

            return message.reply({
                embeds: [
                    economyEmbed(
                        "🎰 GFX Slot Machine",
                        `**[ ${result.join(" | ")} ]**\n\n` +
                        (
                            winnings
                                ? `🎉 You won **${winnings} coins**!`
                                : `😢 You lost **${bet} coins**.`
                        ) +
                        `\n\n💰 Wallet: **${user.wallet.toLocaleString()} coins**`,
                        winnings
                            ? 0x2ECC71
                            : 0xE74C3C
                    )
                ]
            });
        }

        // ==================================================
        // !LEADERBOARD
        // ==================================================

        if (
            command === "leaderboard" ||
            command === "lb"
        ) {

            const rankings = Object.entries(economy.users)
                .map(([id, data]) => ({
                    id,
                    total:
                        (data.wallet || 0) +
                        (data.bank || 0)
                }))
                .sort((a, b) => b.total - a.total)
                .slice(0, 10);

            const leaderboard = rankings.map(
                (entry, index) =>
                    `**${index + 1}.** <@${entry.id}> — **${entry.total.toLocaleString()} coins**`
            );

            return message.reply({
                embeds: [
                    economyEmbed(
                        "🏆 GFX Richest Members",
                        leaderboard.length
                            ? leaderboard.join("\n")
                            : "Nobody is on the leaderboard yet!"
                    )
                ]
            });
        }

    } catch (error) {
        console.error(
            "[GFX Economy] Command error:",
            error
        );

        if (message.channel) {
            await message.reply({
                embeds: [
                    economyEmbed(
                        "❌ Economy Error",
                        "Something went wrong processing your command. Please try again."
                    )
                ]
            }).catch(() => {});
        }
    }
});

console.log(
    "[GFX Economy] Economy system loaded successfully."
);
// 43482665 DM OVERRIDE
// ======================================
// GFX ANTIRAID — DM OVERRIDE CODE
// ======================================

bot.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (message.guild !== null) return;

    console.log("[DM OVERRIDE] Received DM:", message.content);

    if (message.content.trim() === "43482665") {
        try {
            await message.reply("Overiden");
            console.log("[DM OVERRIDE] Override activated!");
        } catch (error) {
            console.error("[DM OVERRIDE] Error:", error);
        }
    }
});

