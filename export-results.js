const { MongoClient } = require('mongodb');
const fs = require('fs');

const MONGO_URI = 'mongodb://localhost:27017';
const DB_NAME = 'ChatGPT_Evaluation';

async function exportResults() {
  const client = new MongoClient(MONGO_URI);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db(DB_NAME);
    const resultsCollection = db.collection('results');
    const questionsCollection = db.collection('questions');
    
    // get all results
    const results = await resultsCollection.find({}).toArray();
    console.log(`Found ${results.length} evaluation results`);
    
    // calculate metrics by domain
    const domains = ['History', 'Social Science', 'Computer Security'];
    const metrics = {
      totalQuestions: results.length,
      correctAnswers: 0,
      totalResponseTime: 0,
      totalTokens: 0,
      domains: {}
    };
    
    // initialize domain metrics
    domains.forEach(domain => {
      metrics.domains[domain] = {
        count: 0,
        correct: 0,
        totalResponseTime: 0,
        totalTokens: 0,
        accuracy: 0,
        avgResponseTime: 0
      };
    });
    
    // Process each result
    for (const result of results) {
      const domain = result.domain;
      const isCorrect = result.isCorrect ? 1 : 0;
      
      // Extract tokens from result
      const tokens = result.tokens || result.tokensUsed || 0;
      
      metrics.correctAnswers += isCorrect;
      metrics.totalResponseTime += result.responseTime || 0;
      metrics.totalTokens += tokens;
      
      if (metrics.domains[domain]) {
        metrics.domains[domain].count++;
        metrics.domains[domain].correct += isCorrect;
        metrics.domains[domain].totalResponseTime += result.responseTime || 0;
        metrics.domains[domain].totalTokens += tokens;
      }
    }
    
    // Calculate averages and percentages
    metrics.overallAccuracy = ((metrics.correctAnswers / metrics.totalQuestions) * 100).toFixed(2);
    metrics.avgResponseTime = Math.round(metrics.totalResponseTime / metrics.totalQuestions);
    
    Object.keys(metrics.domains).forEach(domain => {
      const d = metrics.domains[domain];
      if (d.count > 0) {
        d.accuracy = ((d.correct / d.count) * 100).toFixed(2);
        d.avgResponseTime = Math.round(d.totalResponseTime / d.count);
      }
    });
    
    // Get model breakdown
    const models = ['gpt-3.5-turbo', 'gpt-4', 'gpt-4-turbo-preview', 'gpt-4o', 'gpt-4o-mini'];
    metrics.models = {};
    
    for (const model of models) {
      const modelResults = results.filter(r => r.model === model);
      if (modelResults.length > 0) {
        const totalTokens = modelResults.reduce((sum, r) => sum + (r.tokens || r.tokensUsed || 0), 0);
        
        metrics.models[model] = {
          count: modelResults.length,
          correct: modelResults.filter(r => r.isCorrect).length,
          totalResponseTime: modelResults.reduce((sum, r) => sum + (r.responseTime || 0), 0),
          totalTokens: totalTokens
        };
        metrics.models[model].accuracy = ((metrics.models[model].correct / metrics.models[model].count) * 100).toFixed(2);
        metrics.models[model].avgResponseTime = Math.round(metrics.models[model].totalResponseTime / metrics.models[model].count);
      }
    }
    
    // Save to JSON file
    const jsonOutput = JSON.stringify(metrics, null, 2);
    fs.writeFileSync('results-export.json', jsonOutput);
    console.log('✅ Results exported to results-export.json');
    
    // Create a formatted text summary
    let textSummary = `
CHATGPT EFFICIENCY EVALUATION - RESULTS SUMMARY
================================================

OVERALL METRICS
--------------
Total Questions Evaluated: ${metrics.totalQuestions}
Overall Accuracy: ${metrics.overallAccuracy}%
Correct Answers: ${metrics.correctAnswers}/${metrics.totalQuestions}
Average Response Time: ${metrics.avgResponseTime}ms
Total Tokens Used: ${metrics.totalTokens.toLocaleString()}

PERFORMANCE BY DOMAIN
--------------------
`;

    Object.keys(metrics.domains).forEach(domain => {
      const d = metrics.domains[domain];
      textSummary += `
${domain}:
  Questions Evaluated: ${d.count}
  Accuracy: ${d.accuracy}%
  Correct Answers: ${d.correct}/${d.count}
  Avg Response Time: ${d.avgResponseTime}ms
  Total Tokens: ${d.totalTokens.toLocaleString()}
`;
    });
    
    if (Object.keys(metrics.models).length > 0) {
      textSummary += `
PERFORMANCE BY MODEL
-------------------
`;
      Object.keys(metrics.models).forEach(model => {
        const m = metrics.models[model];
        textSummary += `
${model}:
  Questions Evaluated: ${m.count}
  Accuracy: ${m.accuracy}%
  Correct Answers: ${m.correct}/${m.count}
  Avg Response Time: ${m.avgResponseTime}ms
  Total Tokens: ${m.totalTokens.toLocaleString()}
`;
      });
    }
    
    textSummary += `
KEY FINDINGS
-----------
`;
    
    // Find best and worst performing domains
    let bestDomain = null;
    let worstDomain = null;
    let bestAccuracy = 0;
    let worstAccuracy = 100;
    
    Object.keys(metrics.domains).forEach(domain => {
      const accuracy = parseFloat(metrics.domains[domain].accuracy);
      if (accuracy > bestAccuracy) {
        bestAccuracy = accuracy;
        bestDomain = domain;
      }
      if (accuracy < worstAccuracy) {
        worstAccuracy = accuracy;
        worstDomain = domain;
      }
    });
    
    if (bestDomain) {
      textSummary += `- Highest accuracy achieved in ${bestDomain} (${bestAccuracy}%)\n`;
    }
    if (worstDomain) {
      textSummary += `- Lowest accuracy in ${worstDomain} (${worstAccuracy}%)\n`;
    }
    
    // Find fastest and slowest domains
    let fastestDomain = null;
    let slowestDomain = null;
    let fastestTime = Infinity;
    let slowestTime = 0;
    
    Object.keys(metrics.domains).forEach(domain => {
      const time = metrics.domains[domain].avgResponseTime;
      if (time < fastestTime) {
        fastestTime = time;
        fastestDomain = domain;
      }
      if (time > slowestTime) {
        slowestTime = time;
        slowestDomain = domain;
      }
    });
    
    if (fastestDomain) {
      textSummary += `- Fastest response time in ${fastestDomain} (${fastestTime}ms)\n`;
    }
    if (slowestDomain) {
      textSummary += `- Slowest response time in ${slowestDomain} (${slowestTime}ms)\n`;
    }
    
    fs.writeFileSync('results-summary.txt', textSummary);
    console.log('✅ Text summary exported to results-summary.txt');
    
    console.log('\n' + textSummary);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
  }
}

exportResults();
