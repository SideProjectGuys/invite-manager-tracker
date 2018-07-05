import * as amqplib from 'amqplib';
import { Client, Guild, Invite, Role } from 'eris';

import {
	channels,
	defaultSettings,
	guilds,
	inviteCodes,
	joins,
	leaves,
	members,
	ranks,
	roles,
	sequelize,
	SettingAttributes,
	settings,
	SettingsKey
} from './sequelize';

const config = require('../config.json');

const GUILD_START_INTERVAL = 50;

// First two arguments are "node" and "<filename>"
if (process.argv.length < 4) {
	console.error('-------------------------------------');
	console.error('Syntax: invite-tracker.js <shardId> <shardCount>');
	console.error('-------------------------------------');
	process.exit(1);
}
const shardId = parseInt(process.argv[2], 10);
const shardCount = parseInt(process.argv[3], 10);

const prefix = config.rabbitmq.prefix ? config.rabbitmq.prefix + '-' : '';
const qJoinsName = prefix + 'joins-' + shardId + '-' + shardCount;
const qLeavesName = prefix + 'leaves-' + shardId + '-' + shardCount;

const client = new Client(config.discordToken, {
	firstShardID: shardId - 1,
	lastShardID: shardId - 1,
	maxShards: shardCount,
	largeThreshold: 100,
	messageLimit: 1,
	disableEvents: {
		MESSAGE_CREATE: false,
		MESSAGE_DELETE: false,
		MESSAGE_UPDATE: false,
		MESSAGE_DELETE_BULK: false,

		// Other events we don't need
		PRESENCE_UPDATE: false,
		VOICE_STATE_UPDATE: false,
		TYPING_START: false,
		CHANNEL_CREATE: false,
		CHANNEL_DELETE: false,
		CHANNEL_UPDATE: false
	}
});

process.on('unhandledRejection', (reason: any, p: any) => {
	console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

let sendChannel: amqplib.Channel;
const inviteStore: { [key: string]: { [key: string]: number } } = {};

function getInviteCounts(invs: Invite[]): { [key: string]: number } {
	let localInvites: { [key: string]: number } = {};
	invs.forEach(value => {
		localInvites[value.code] = value.uses;
	});
	return localInvites;
}

function compareInvites(
	oldObj: { [key: string]: number },
	newObj: { [key: string]: number }
): string[] {
	let inviteCodesUsed: string[] = [];
	Object.keys(newObj).forEach(key => {
		if (
			newObj[key] !== 0 /* ignore new empty invites */ &&
			oldObj[key] !== newObj[key]
		) {
			inviteCodesUsed.push(key);
		}
	});
	return inviteCodesUsed;
}

const enum ChannelType {
	GUILD_TEXT = 0,
	DM = 1,
	GUILD_VOICE = 2,
	GROUP_DM = 3,
	GUILD_CATEGORY = 4
}

const getDefaultChannel = async (guild: Guild) => {
	// get "original" default channel
	if (guild.channels.has(guild.id)) {
		return guild.channels.get(guild.id);
	}

	// Check for a "general" channel, which is often default chat
	const gen = guild.channels.find(c => c.name === 'general');
	if (gen) {
		return gen;
	}

	// First channel in order where the bot can speak
	return guild.channels
		.filter(
			c =>
				c.type ===
				ChannelType.GUILD_TEXT /*&&
				c.permissionsOf(guild.self).has('SEND_MESSAGES')*/
		)
		.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))[0];
};

async function insertGuildData(guild: Guild, isNew: boolean = false) {
	// Get the invites
	const invs = await guild.getInvites();

	// Filter out new invite codes
	const newInviteCodes = invs.filter(
		inv => typeof inviteStore[inv.guild.id][inv.code] === 'undefined'
	);

	// Update our local cache
	inviteStore[guild.id] = getInviteCounts(invs);

	// Collect concurrent promises
	const promises: any[] = [];

	// Insert settings if this is a new guild
	if (isNew) {
		const defChannel = await getDefaultChannel(guild);

		const sets: SettingAttributes[] = Object.keys(defaultSettings)
			.filter((key: SettingsKey) => defaultSettings[key] !== null)
			.map((key: SettingsKey) => ({
				id: null,
				key,
				value:
					key === SettingsKey.joinMessageChannel
						? defChannel.id
						: defaultSettings[key],
				guildId: guild.id
			}));

		promises.push(
			settings.bulkCreate(sets, {
				ignoreDuplicates: true
			})
		);
	}

	// Add all new inviters to db
	promises.push(
		members.bulkCreate(
			newInviteCodes
				.map(i => i.inviter)
				.filter(
					(u, i, arr) => u && arr.findIndex(u2 => u2 && u2.id === u.id) === i
				)
				.map(m => ({
					id: m.id,
					name: m.username,
					discriminator: m.discriminator,
					createdAt: m.createdAt
				})),
			{
				updateOnDuplicate: ['name', 'discriminator', 'updatedAt']
			}
		)
	);

	// Add all new invite channels to the db
	promises.push(
		channels.bulkCreate(
			newInviteCodes
				.map(i => guild.channels.get(i.channel.id))
				.filter((c, i, arr) => c && arr.findIndex(c2 => c2.id === c.id) === i)
				.map(c => ({
					id: c.id,
					name: c.name,
					guildId: guild.id,
					createdAt: c.createdAt
				})),
			{
				updateOnDuplicate: ['name', 'updatedAt']
			}
		)
	);

	await Promise.all(promises);

	const codes = invs.map(inv => ({
		createdAt: inv.createdAt ? inv.createdAt : new Date(),
		code: inv.code,
		channelId: inv.channel ? inv.channel.id : null,
		maxAge: inv.maxAge,
		maxUses: inv.maxUses,
		uses: inv.uses,
		temporary: inv.temporary,
		guildId: guild.id,
		inviterId: inv.inviter ? inv.inviter.id : null
	}));

	// Then insert invite codes
	return inviteCodes.bulkCreate(codes, {
		updateOnDuplicate: ['uses', 'updatedAt']
	});
}

client.on('ready', async () => {
	console.log(`Logged in as ${client.user.username}!`);

	const allGuilds = client.guilds;

	// Insert guilds into db
	guilds.bulkCreate(
		allGuilds.map(g => ({
			id: g.id,
			name: g.name,
			icon: g.iconURL,
			memberCount: g.memberCount,
			deletedAt: null
		})),
		{
			updateOnDuplicate: [
				'name',
				'icon',
				'memberCount',
				'updatedAt',
				'deletedAt'
			]
		}
	);

	// Fetch all invites from DB
	const allCodes = await inviteCodes.findAll({
		where: {
			guildId: allGuilds.map(g => g.id)
		},
		raw: true
	});

	// Initialize our cache for each guild, so we
	// don't need to do any if checks later
	allGuilds.forEach(guild => {
		inviteStore[guild.id] = {};
	});

	// Update our cache to match the DB
	allCodes.forEach(inv => (inviteStore[inv.guildId][inv.code] = inv.uses));

	let i = 0;
	allGuilds.forEach(async guild => {
		const func = async () => {
			try {
				// Insert data into db
				await insertGuildData(guild);

				console.log(
					'EVENT(clientReady):Updated invite count for ' + guild.name
				);
			} catch (e) {
				console.log(`ERROR in EVENT(clientReady):${guild.id},${guild.name}`, e);
			}
		};
		setTimeout(func, i * GUILD_START_INTERVAL);
		i++;
	});

	// Message tracking (TODO: Enable once message tracking is ready)
	// setInterval(saveMessages, 10000);
});

client.on('guildCreate', async (guild: Guild) => {
	await guilds.insertOrUpdate({
		id: guild.id,
		name: guild.name,
		icon: guild.iconURL,
		memberCount: guild.memberCount,
		deletedAt: null
	});

	try {
		// Insert data into db
		await insertGuildData(guild, true);

		console.log('EVENT(guildCreate):Updated invite count for ' + guild.name);
	} catch (e) {
		console.log(`ERROR in EVENT(guildCreate):${guild.id},${guild.name}`, e);
	}
});

client.on('guildDelete', async (guild: Guild) => {
	// Remove the guild (only sets the 'deletedAt' timestamp)
	await guilds.destroy({
		where: {
			id: guild.id
		}
	});
});

client.on('guildMemberAdd', async (guild, member) => {
	console.log(
		'EVENT(guildMemberAdd):',
		guild.name,
		member.user.username,
		member.user.discriminator
	);

	if (member.user.bot) {
		return;
	}

	const invs = await guild.getInvites();
	const newInvs = getInviteCounts(invs);
	const oldInvs = inviteStore[guild.id];
	inviteStore[guild.id] = newInvs;

	if (!oldInvs) {
		console.error(
			'Invite cache for guild ' +
				guild.id +
				' was undefined when adding member ' +
				member.id
		);
		return;
	}

	let exactMatchCode: string = null;
	let possibleMatches: string = null;

	const inviteCodesUsed = compareInvites(oldInvs, newInvs);
	if (inviteCodesUsed.length === 1) {
		exactMatchCode = inviteCodesUsed[0];
	} else {
		possibleMatches = inviteCodesUsed.join(',');
	}

	if (inviteCodesUsed.length === 0) {
		console.error(
			`NO USED INVITE CODE FOUND: g:${guild.id} | m: ${member.id} ` +
				`| t:${member.joinedAt} | invs: ${JSON.stringify(newInvs)} ` +
				`| oldInvs: ${JSON.stringify(oldInvs)}`
		);
	}

	const newMembers = inviteCodesUsed
		.map(code => invs.find(i => i.code === code).inviter)
		.filter(inviter => !!inviter)
		.concat(member.user) // Add invitee
		.map(m => ({
			id: m.id,
			name: m.username,
			discriminator: m.discriminator
		}));
	const membersPromise = members.bulkCreate(newMembers, {
		updateOnDuplicate: ['name', 'discriminator', 'updatedAt']
	});

	const channelPromise = channels.bulkCreate(
		inviteCodesUsed
			.map(code => invs.find(i => i.code === code).channel)
			.map(channel => ({
				id: channel.id,
				guildId: member.guild.id,
				name: channel.name
			})),
		{
			updateOnDuplicate: ['name', 'updatedAt']
		}
	);

	// We need the members and channels in the DB for the invite codes
	const [ms, cs] = await Promise.all([membersPromise, channelPromise]);

	const codes = inviteCodesUsed.map(code => {
		const inv = invs.find(i => i.code === code);
		return {
			createdAt: inv.createdAt ? inv.createdAt : new Date(),
			code: inv.code,
			channelId: inv.channel ? inv.channel.id : null,
			isNative: !inv.inviter || inv.inviter.id !== client.user.id,
			maxAge: inv.maxAge,
			maxUses: inv.maxUses,
			uses: inv.uses,
			temporary: inv.temporary,
			guildId: member.guild.id,
			inviterId: inv.inviter ? inv.inviter.id : null
		};
	});

	// We need the invite codes in the DB for the join
	await inviteCodes.bulkCreate(codes, {
		updateOnDuplicate: ['uses', 'updatedAt']
	});

	const join = await joins.create({
		id: null,
		exactMatchCode,
		possibleMatches,
		memberId: member.id,
		guildId: guild.id,
		createdAt: member.joinedAt,
		leaveId: null
	});

	// Send to RabbitMQ
	const data = {
		guildId: guild.id,
		member: {
			id: member.id,
			nick: member.nick,
			user: {
				id: member.user.id,
				username: member.user.username,
				discriminator: member.user.discriminator,
				bot: member.user.bot,
				createdAt: member.user.createdAt,
				avatarUrl: member.user.avatarURL
			}
		},
		join
	};
	sendChannel.sendToQueue(qJoinsName, Buffer.from(JSON.stringify(data)));
});

client.on('guildMemberRemove', async (guild, member) => {
	console.log(
		'EVENT(guildMemberRemove):',
		guild.name,
		member.user.username,
		member.user.discriminator
	);

	const join = await joins.find({
		where: {
			guildId: guild.id,
			memberId: member.id
		},
		order: [['createdAt', 'DESC']],
		include: [
			{
				model: inviteCodes,
				as: 'exactMatch',
				include: [
					{
						model: members,
						as: 'inviter'
					},
					{
						model: channels
					}
				]
			}
		],
		raw: true
	});

	// We need the member in the DB for the leave
	await members.insertOrUpdate({
		id: member.id,
		name: member.user.username,
		discriminator: member.user.discriminator
	});

	const leave = (await leaves.bulkCreate(
		[
			{
				id: null,
				memberId: member.id,
				guildId: guild.id,
				joinId: join ? join.id : null
			}
		],
		{
			updateOnDuplicate: []
		}
	))[0];

	// Send to RabbitMQ
	const data = {
		guildId: guild.id,
		member: {
			id: member.id,
			user: {
				id: member.user.id,
				username: member.user.username,
				discriminator: member.user.discriminator,
				bot: member.user.bot,
				createdAt: member.user.createdAt,
				avatarUrl: member.user.avatarURL
			}
		},
		join,
		leave
	};
	sendChannel.sendToQueue(qLeavesName, Buffer.from(JSON.stringify(data)));
});

client.on('guildRoleCreate', async (guild: Guild, role: Role) => {
	let color = role.color.toString(16);
	if (color.length < 6) {
		color = '0'.repeat(6 - color.length) + color;
	}
	await roles.insertOrUpdate({
		id: role.id,
		name: role.name,
		color: color,
		guildId: role.guild.id,
		createdAt: role.createdAt
	});
});

client.on('guildRoleDelete', async (_: Guild, role: Role) => {
	const ranksPromise = ranks.destroy({
		where: {
			roleId: role.id,
			guildId: role.guild.id
		}
	});

	const rolesPromise = roles.destroy({
		where: {
			id: role.id,
			guildId: role.guild.id
		}
	});

	await Promise.all([ranksPromise, rolesPromise]);
});

/*
type MsgCache = { [x: string]: { [x: string]: { [x: string]: number } } };
let msgCache: MsgCache = {};
client.on('messageCreate', message => {
	if (message.author.bot) {
		return;
	}

	const guildId = message.guild.id;
	let guildCache = msgCache[guildId];
	if (!guildCache) {
		guildCache = {};
		msgCache[guildId] = guildCache;
	}

	const channelId = message.channel.id;
	let channelCache = guildCache[channelId];
	if (!channelCache) {
		channelCache = {};
		guildCache[channelId] = channelCache;
	}

	const authorId = message.author.id;
	if (!channelCache[authorId]) {
		channelCache[authorId] = 1;
	} else {
		channelCache[authorId]++;
	}
});

function saveMessages() {
	// Clone and reset our cache
	const msgs: MsgCache = JSON.parse(JSON.stringify(msgCache));
	msgCache = {};

	console.log('Saving messages');
	console.log(JSON.stringify(msgs, null, 2));

	const activities: MessageActivityAttributes[] = [];
	Object.keys(msgs).forEach(guildId => {
		const guild = msgs[guildId];
		Object.keys(guild).forEach(channelId => {
			const channel = guild[channelId];
			Object.keys(channel).forEach(memberId => {
				const amount = channel[memberId];
				activities.push({
					id: null,
					guildId,
					channelId,
					memberId,
					amount: Sequelize.literal(`COALESCE(amount, 0) + ${amount}`),
					timestamp: Sequelize.fn(
						'DATE_FORMAT',
						Sequelize.fn(
							'DATE_ADD',
							Sequelize.literal('NOW()'),
							Sequelize.literal('INTERVAL 1 HOUR')
						),
						'%Y-%m-%d %H:00:00'
					)
				});
			});
		});
	});

	if (activities.length) {
		messageActivities.bulkCreate(activities, {
			updateOnDuplicate: ['amount + amount', 'updatedAt']
		});
	}
}*/

// First sync our db
console.log('Syncing db...');
sequelize.sync().then(() => {
	console.log('Connecting to RabbitMQ...');
	// Then connect to RabbitMQ
	amqplib
		.connect(config.rabbitmq)
		.then(async conn => {
			// Setup RabbitMQ channels
			sendChannel = await conn.createChannel();
			await sendChannel.assertQueue(qJoinsName, {
				durable: true
			});
			await sendChannel.assertQueue(qLeavesName, {
				durable: true
			});

			// And finally connect to discord
			console.log('Logging in to discord...');
			client
				.connect()
				.then(() => console.log('Ready!'))
				.catch(console.log);
		})
		.catch(console.log);
});
