// Simplified server without MongoDB - uses JSON files instead
const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');
const OpenAI = require('openai');
const cors = require('cors');
const fs = require('fs');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// JSON file storage paths
const QUESTIONS_FILE = path.join(__dirname, 'data', 'questions.json');
const RESULTS_FILE = path.join(__dirname, 'data', 'results.json');

// Create data directory if it doesn't exist
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}

// OpenAI Configuration
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'your-api-key-here'
});

//functions for file storage
function readQuestions() {
    if (fs.existsSync(QUESTIONS_FILE)) {
        return JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf-8'));
    }
    return [];
}

function writeQuestions(questions) {
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2));
}

function readResults() {
    if (fs.existsSync(RESULTS_FILE)) {
        return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
    }
    return [];
}

function writeResults(results) {
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({
        type: 'system',
        message: 'Connected to server',
        timestamp: new Date().toISOString()
    }));
    
    ws.on('close', () => clients.delete(ws));
});

function broadcastProgress(data) {
    const message = JSON.stringify({ type: 'progress', ...data, timestamp: new Date().toISOString() });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
}

// parse CSV and populate database
async function populateDatabase() {
    const datasets = [
        { file: 'computer_security_test.csv', domain: 'Computer Security' },
        { file: 'prehistory_test.csv', domain: 'History' },
        { file: 'sociology_test.csv', domain: 'Social Science' }
    ];

    let allQuestions = [];
    
    for (const dataset of datasets) {
        const filePath = path.join('c:', 'Users', 'caela', 'Downloads', 'ITEC4020_dataset-20251111T203100Z-1-001', 'ITEC4020_dataset', dataset.file);
        
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').filter(line => line.trim());
            
            lines.forEach((line, index) => {
                const parts = line.split(',');
                if (parts.length >= 2) {
                    allQuestions.push({
                        id: `${dataset.domain.replace(/\s/g, '_')}_${index}`,
                        domain: dataset.domain,
                        question: parts[0].trim(),
                        choices: parts.slice(1).map(c => c.trim()).filter(c => c),
                        processed: false
                    });
                }
            });
        }
    }
    
    writeQuestions(allQuestions);
    return allQuestions.length;
}

async function queryChatGPT(question, choices) {
    const startTime = Date.now();
    try {
        const prompt = `Question: ${question}\n\nChoices:\n${choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nPlease provide the correct answer and explanation.`;
        
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: "You are a helpful assistant answering multiple choice questions." },
                { role: "user", content: prompt }
            ],
            max_tokens: 500,
            temperature: 0.7
        });

        return {
            response: completion.choices[0].message.content,
            responseTime: Date.now() - startTime,
            tokens: completion.usage.total_tokens,
            success: true
        };
    } catch (error) {
        return {
            response: `Error: ${error.message}`,
            responseTime: Date.now() - startTime,
            tokens: 0,
            success: false,
            error: error.message
        };
    }
}

async function processAllQuestions() {
    const questions = readQuestions();
    const unprocessed = questions.filter(q => !q.processed);
    let results = readResults();
    
    for (let i = 0; i < unprocessed.length; i++) {
        const question = unprocessed[i];
        const result = await queryChatGPT(question.question, question.choices);
        
        results.push({
            questionId: question.id,
            domain: question.domain,
            question: question.question,
            choices: question.choices,
            chatgptResponse: result.response,
            responseTime: result.responseTime,
            tokens: result.tokens,
            success: result.success,
            processedAt: new Date().toISOString()
        });
        
        question.processed = true;
        
        broadcastProgress({
            message: `Processed ${i + 1}/${unprocessed.length} - ${question.domain}`,
            total: unprocessed.length,
            processed: i + 1
        });
        
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    writeQuestions(questions);
    writeResults(results);
    return { total: unprocessed.length, processed: unprocessed.length };
}

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/:section', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/add', (req, res) => {
    const a = parseFloat(req.query.a);
    const b = parseFloat(req.query.b);
    if (isNaN(a) || isNaN(b)) {
        return res.status(400).json({ error: 'Invalid numbers' });
    }
    res.json({ a, b, result: a + b, timestamp: new Date().toISOString() });
});

app.post('/api/populate', async (req, res) => {
    try {
        writeQuestions([]);
        writeResults([]);
        const count = await populateDatabase();
        res.json({ success: true, message: `Populated ${count} questions`, count });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/process', async (req, res) => {
    try {
        const result = await processAllQuestions();
        res.json({ success: true, message: 'Processed successfully', ...result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/results', (req, res) => {
    try {
        const results = readResults();
        const metrics = {
            totalQuestions: results.length,
            successfulResponses: results.filter(r => r.success).length,
            domains: {}
        };
        
        results.forEach(r => {
            if (!metrics.domains[r.domain]) {
                metrics.domains[r.domain] = {
                    count: 0,
                    avgResponseTime: 0,
                    totalTokens: 0,
                    successful: 0
                };
            }
            const d = metrics.domains[r.domain];
            d.count++;
            d.avgResponseTime += r.responseTime;
            d.totalTokens += r.tokens;
            if (r.success) d.successful++;
        });
        
        Object.keys(metrics.domains).forEach(domain => {
            metrics.domains[domain].avgResponseTime = Math.round(
                metrics.domains[domain].avgResponseTime / metrics.domains[domain].count
            );
        });
        
        res.json({ success: true, metrics, results });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/status', (req, res) => {
    const questions = readQuestions();
    const results = readResults();
    res.json({
        success: true,
        database: {
            connected: true,
            totalQuestions: questions.length,
            processedQuestions: questions.filter(q => q.processed).length,
            unprocessedQuestions: questions.filter(q => !q.processed).length,
            totalResults: results.length,
            storageType: 'JSON Files'
        }
    });
});

server.listen(port, () => {
    console.log(`\n========================================`);
    console.log(`🚀 Server running on http://localhost:${port}`);
    console.log(`💾 Storage: JSON Files (no MongoDB needed)`);
    console.log(`========================================\n`);
});
