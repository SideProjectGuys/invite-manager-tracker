import * as amqplib from 'amqplib';
import { Client } from 'eris';

import { RabbitMq } from './services/RabbitMq';
import { Tracking } from './services/Tracking';
import { ShardCommand } from './types';

const config = require('../config.json');

export class IMClient extends Client {
	public config: any;

	public startedAt: Date;
	public gatewayConnected: boolean;

	public tracking: Tracking;

	public rabbitmq: RabbitMq;
	public shardId: number;
	public shardCount: number;

	public disabledGuilds: Set<string> = new Set();

	public constructor(
		conn: amqplib.Connection,
		token: string,
		shardId: number,
		shardCount: number,
		_prefix: string
	) {
		super(token, {
			disableEveryone: true,
			firstShardID: shardId - 1,
			lastShardID: shardId - 1,
			maxShards: shardCount,
			restMode: true,
			messageLimit: 1,
			largeThreshold: 100,
			getAllUsers: false,
			compress: true,
			guildCreateTimeout: 60000,
			disableEvents: {
				// TODO: Enable for activity tracking
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

		this.startedAt = new Date();

		this.config = config;
		if (_prefix) {
			this.config.rabbitmq.prefix = _prefix;
		}

		this.rabbitmq = new RabbitMq(this, conn);
		this.tracking = new Tracking(this);

		this.on('ready', this.onReady);
		this.on('connect', this.onConnect);
		this.on('disconnect', this.onDisconnect);
		this.on('warn', this.onWarn);
		this.on('error', this.onError);
	}

	private async onReady() {
		console.log(`Client ready! Serving ${this.guilds.size} guilds.`);

		// Message tracking (TODO: Enable once message tracking is ready)
		// setInterval(saveMessages, 10000);
	}

	private async onConnect() {
		console.error('DISCORD CONNECT');
		this.rabbitmq.sendToManager({
			id: 'status',
			cmd: ShardCommand.STATUS,
			connected: true
		});
		this.gatewayConnected = true;
	}

	private async onDisconnect() {
		console.error('DISCORD DISCONNECT');
		this.rabbitmq.sendToManager({
			id: 'status',
			cmd: ShardCommand.STATUS,
			connected: false
		});
		this.gatewayConnected = false;
	}

	private async onWarn(warn: string) {
		console.error('DISCORD WARNING:', warn);
	}

	private async onError(error: Error) {
		console.error('DISCORD ERROR:', error);
	}
}
