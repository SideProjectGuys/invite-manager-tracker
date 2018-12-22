import * as amqplib from 'amqplib';

import { IMClient } from './client';
import { sequelize } from './sequelize';

const config = require('../config.json');

// First two arguments are "node" and "<filename>"
if (process.argv.length < 5) {
	console.error('-------------------------------------');
	console.error('Syntax: tracker.js <token> <shardId> <shardCount> (<prefix>)');
	console.error('-------------------------------------');
	process.exit(1);
}
const token = process.argv[2];
const shardId = parseInt(process.argv[3], 10);
const shardCount = parseInt(process.argv[4], 10);
const _prefix = process.argv[5];

process.on('unhandledRejection', (reason: any, p: any) => {
	console.error('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

// First sync our db
console.log('-------------------------------------');
console.log('Syncing database...');
console.log('-------------------------------------');
sequelize.sync().then(() => {
	// Then connect to RabbitMQ
	console.log('-------------------------------------');
	console.log('Connecting to RabbitMQ...');
	console.log('-------------------------------------');
	amqplib
		.connect(config.rabbitmq)
		.then(async conn => {
			console.log('-------------------------------------');
			console.log(`This is shard ${shardId}/${shardCount}`);
			console.log('-------------------------------------');
			const client = new IMClient(conn, token, shardId, shardCount, _prefix);

			console.log('-------------------------------------');
			console.log('Starting tracker...');
			console.log('-------------------------------------');
			client.connect();
		})
		.catch(console.log);
});
