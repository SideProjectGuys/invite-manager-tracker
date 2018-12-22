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
