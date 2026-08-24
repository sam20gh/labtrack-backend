/**
 * Test harness.
 *
 * Runs against an in-memory MongoDB rather than Atlas: tests that write to the real
 * database are tests nobody dares run, and a suite that cannot be run freely is a suite
 * that stops being maintained.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongo;

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.SECRET_KEY = 'test-secret-key-for-jest';
    process.env.MONGO_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri());
}, 60000);

afterEach(async () => {
    // Between tests, not after all of them: leakage between cases is how a suite starts
    // passing for the wrong reasons
    const collections = await mongoose.connection.db.collections();
    for (const c of collections) await c.deleteMany({});
});

afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
}, 30000);
