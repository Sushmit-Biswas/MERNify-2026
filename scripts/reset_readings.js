import mongoose from 'mongoose';
import '../server/src/env.js';
import { config } from '../server/src/config.js';
import { Reading } from '../server/src/models/Reading.js';

const uri = process.env.MONGO_URI || config.mongoUri;
console.log('Connecting to Mongo Atlas...');
await mongoose.connect(uri);

console.log('Dropping bloated readings collection...');
try {
  await mongoose.connection.db.collection('readings').drop();
  console.log('Readings collection dropped successfully.');
} catch (err) {
  console.log('Drop error or already empty:', err.message);
}

console.log('Re-syncing Reading indexes...');
await Reading.syncIndexes();

const stats = await mongoose.connection.db.stats();
console.log('New Storage Size:', (stats.storageSize / (1024 * 1024)).toFixed(2), 'MB');
console.log('New Data Size:', (stats.dataSize / (1024 * 1024)).toFixed(2), 'MB');

await mongoose.disconnect();
console.log('Done! Database space reclaimed.');
