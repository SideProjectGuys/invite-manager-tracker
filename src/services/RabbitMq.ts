import * as amqplib from 'amqplib';

import { IMClient } from '../client';
import { ShardCommand, ShardMessage } from '../types';

export class RabbitMq {
	private client: IMClient;
	private shard: string;

	private qJoinsName: string;
	private qLeavesName: string;
	public channelSend: amqplib.Channel;

	private qCmdsName: string;
	private channelCmds: amqplib.Channel;

	public constructor(client: IMClient, conn: amqplib.Connection) {
		this.client = client;
		this.shard = client.config.rabbitmq.prefix
			? client.config.rabbitmq.prefix
			: this.client.shardId;

		// Setup RabbitMQ channels
		const prefix = client.config.rabbitmq.prefix
			? `${client.config.rabbitmq.prefix}-`
			: '';
		const suffix = `${this.client.shardId}-${this.client.shardCount}`;

		this.qJoinsName = `${prefix}joins-${suffix}`;
		this.qLeavesName = `${prefix}leaves-${suffix}`;
		conn.createChannel().then(async channel => {
			this.channelSend = channel;

			await channel.assertQueue(this.qJoinsName, {
				durable: true
			});

			await channel.assertQueue(this.qLeavesName, {
				durable: true
			});
		});

		this.qCmdsName = `shard-${this.shard}-tracker`;
		conn.createChannel().then(async channel => {
			this.channelCmds = channel;

			await channel.assertQueue(this.qCmdsName, {
				durable: false,
				autoDelete: true
			});

			await channel.assertExchange('shards', 'fanout', {
				durable: true
			});

			await channel.bindQueue(this.qCmdsName, 'shards', '');

			await channel.assertExchange(`shard-${this.shard}`, 'fanout', {
				durable: true
			});

			await channel.bindQueue(this.qCmdsName, `shard-${this.shard}`, '');
		});

		client.on('ready', this.onReady.bind(this));
	}

	public async onReady() {
		await this.channelCmds.prefetch(5);
		this.channelCmds.consume(this.qCmdsName, msg => this.onShardCommand(msg), {
			noAck: false
		});
	}

	public sendToJoins(data: any) {
		this.channelSend.sendToQueue(
			this.qJoinsName,
			Buffer.from(JSON.stringify(data))
		);
	}

	public sendToLeaves(data: any) {
		this.channelSend.sendToQueue(
			this.qLeavesName,
			Buffer.from(JSON.stringify(data))
		);
	}

	public sendToManager(message: { id: string; [x: string]: any }) {
		this.channelCmds.sendToQueue(
			'manager',
			Buffer.from(
				JSON.stringify({
					shard: this.shard,
					service: 'tracker',
					...message
				})
			)
		);
	}

	private async onShardCommand(msg: amqplib.Message) {
		const content = JSON.parse(msg.content.toString()) as ShardMessage;
		const cmd = content.cmd;

		const guildId = content.guildId;
		const guild = this.client.guilds.get(guildId);

		console.log(`RECEIVED SHARD COMMAND: ${JSON.stringify(content)}`);

		this.channelCmds.ack(msg, false);

		const sendResponse = (message: { [x: string]: any }) =>
			this.sendToManager({
				id: content.id,
				cmd: content.cmd,
				...message
			});

		switch (cmd) {
			case ShardCommand.STATUS:
				sendResponse({
					connected: this.client.gatewayConnected
				});
				break;

			case ShardCommand.LEAVE_GUILD:
				if (!guild) {
					return sendResponse({
						error: 'Guild not found'
					});
				}

				await guild.leave();
				sendResponse({});
				break;

			default:
				console.error(`UNKNOWN COMMAND: ${cmd}`);
		}
	}
}
