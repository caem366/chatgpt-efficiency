const { MongoClient } = require('mongodb');

const MONGO_URI = 'mongodb://localhost:27017';
const DB_NAME = 'ChatGPT_Evaluation';

async function inspectData() {
  const client = new MongoClient(MONGO_URI);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db(DB_NAME);
    const resultsCollection = db.collection('results');
    
    // Get a sample result
    const sample = await resultsCollection.findOne({});
    console.log('\nSample Result Structure:');
    console.log(JSON.stringify(sample, null, 2));
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
  }
}

inspectData();
