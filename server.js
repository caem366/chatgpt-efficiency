const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');
const { MongoClient } = require('mongodb');
const OpenAI = require('openai');
const cors = require('cors');
const fs = require('fs');

const app = express();
const port = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// MongoDB Configuration
// For local MongoDB, use: 'mongodb://localhost:27017'
// For MongoDB Atlas, use: 'mongodb+srv://username:password@cluster.mongodb.net/'
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'ChatGPT_Evaluation';
const RESULTS_EXPORT_FILE = path.join(__dirname, 'results-export.json');
let db;
let historyCollection;
let socialScienceCollection;
let computerSecurityCollection;
let resultsCollection;

// OpenAI Configuration
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'your-api-key-here'
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store connected clients
const clients = new Set();

// WebSocket connection 
wss.on('connection', (ws) => {
    console.log('New client connected');
    clients.add(ws);
    
    ws.send(JSON.stringify({
        type: 'system',
        message: 'Connected to server',
        timestamp: new Date().toISOString(),
        clientCount: clients.size
    }));
    
    broadcastClientCount();
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log('Received:', message);
            
            const response = {
                type: 'echo',
                original: message.message,
                timestamp: new Date().toISOString(),
                clientCount: clients.size
            };
            ws.send(JSON.stringify(response));
            
            const broadcast = {
                type: 'broadcast',
                message: message.message,
                timestamp: new Date().toISOString(),
                from: 'Another user'
            };
            
            clients.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(broadcast));
                }
            });
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });
    
    ws.on('close', () => {
        console.log('Client disconnected');
        clients.delete(ws);
        broadcastClientCount();
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

function broadcastClientCount() {
    const message = JSON.stringify({
        type: 'status',
        message: `${clients.size} client(s) connected`,
        clientCount: clients.size,
        timestamp: new Date().toISOString()
    });
    
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Broadcast progress updates via WebSocket
function broadcastProgress(data) {
    const message = JSON.stringify({
        type: 'progress',
        ...data,
        timestamp: new Date().toISOString()
    });
    
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function loadExportedMetrics(modelFilter = null) {
    if (!fs.existsSync(RESULTS_EXPORT_FILE)) {
        return null;
    }

    const exported = JSON.parse(fs.readFileSync(RESULTS_EXPORT_FILE, 'utf8'));
    const selectedModels = modelFilter && exported.models && exported.models[modelFilter]
        ? { [modelFilter]: exported.models[modelFilter] }
        : exported.models || {};
    const source = modelFilter ? selectedModels[modelFilter] : exported;
    const totalQuestions = source?.count ?? exported.totalQuestions ?? 0;
    const correctAnswers = source?.correct ?? exported.correctAnswers ?? 0;
    const totalTokensUsed = source?.totalTokens ?? exported.totalTokens ?? 0;
    const overallAvgResponseTime = source?.avgResponseTime ?? exported.avgResponseTime ?? 0;
    const overallAccuracy = totalQuestions > 0
        ? ((correctAnswers / totalQuestions) * 100).toFixed(2)
        : '0.00';

    const domains = {};
    if (!modelFilter && exported.domains) {
        Object.entries(exported.domains).forEach(([domain, data]) => {
            domains[domain] = {
                ...data,
                successful: data.count,
                failed: 0,
                incorrect: data.count - data.correct
            };
        });
    }

    const models = {};
    Object.entries(selectedModels).forEach(([modelName, data]) => {
        models[modelName] = {
            ...data,
            successful: data.count,
            failed: 0,
            incorrect: data.count - data.correct,
            domains: data.domains || {}
        };
    });

    return {
        totalQuestions,
        successfulResponses: totalQuestions,
        failedResponses: 0,
        correctAnswers,
        incorrectAnswers: totalQuestions - correctAnswers,
        overallAccuracy,
        overallAvgResponseTime,
        totalTokensUsed,
        models,
        domains
    };
}

// MongoDB Connection
async function connectToMongoDB() {
    try {
        const client = await MongoClient.connect(MONGODB_URI, {
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 5000
        });
        db = client.db(DB_NAME);
        historyCollection = db.collection('History');
        socialScienceCollection = db.collection('Social_Science');
        computerSecurityCollection = db.collection('Computer_Security');
        resultsCollection = db.collection('results');
        console.log('✅ Connected to MongoDB successfully');
        return true;
    } catch (error) {
        console.error('❌ MongoDB connection error:', error.message);
        console.error('⚠️  Please ensure MongoDB is running:');
        console.error('   - Windows: net start MongoDB');
        console.error('   - Or run: mongod --dbpath="C:\\data\\db"');
        return false;
    }
}

// Parse CSV and populate MongoDB
async function populateDatabase() {
    try {
        const datasets = [
            { file: 'computer_security_test.csv', domain: 'Computer Security', collection: 'Computer_Security' },
            { file: 'prehistory_test.csv', domain: 'History', collection: 'History' },
            { file: 'sociology_test.csv', domain: 'Social Science', collection: 'Social_Science' }
        ];

        let totalQuestions = 0;

        for (const dataset of datasets) {
            const filePath = path.join('c:', 'Users', 'caela', 'Downloads', 'ITEC4020_dataset-20251111T203100Z-1-001', 'ITEC4020_dataset', dataset.file);
            
            if (!fs.existsSync(filePath)) {
                console.log(`File not found: ${filePath}`);
                continue;
            }

            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').filter(line => line.trim());

            const questions = [];
            let skipped = 0;
            for (const line of lines) {
                // Handle CSV with quoted fields
                const parts = [];
                let current = '';
                let inQuotes = false;
                
                for (let i = 0; i < line.length; i++) {
                    const char = line[i];
                    if (char === '"') {
                        inQuotes = !inQuotes;
                    } else if (char === ',' && !inQuotes) {
                        parts.push(current.trim());
                        current = '';
                    } else {
                        current += char;
                    }
                }
                parts.push(current.trim());
                
                // CSV format: Question, Choice1, Choice2, Choice3, Choice4, CorrectAnswer
                if (parts.length >= 6) {
                    const question = parts[0].replace(/^"|"$/g, '').trim();
                    const choices = parts.slice(1, 5).map(c => c.replace(/^"|"$/g, '').trim());
                    const correctAnswer = parts[5].replace(/^"|"$/g, '').trim();
                    
                    if (question && choices.length === 4 && correctAnswer) {
                        questions.push({
                            domain: dataset.domain,
                            question: question,
                            choices: choices,
                            correctAnswer: correctAnswer,
                            addedAt: new Date(),
                            processed: false
                        });
                    }
                } else if (parts.length === 5) {
                    // Fallback: if only 5 parts, last one might be answer
                    const question = parts[0].replace(/^"|"$/g, '').trim();
                    const lastPart = parts[4].replace(/^"|"$/g, '').trim();
                    
                    // Check if last part is a single letter (A, B, C, D)
                    if (lastPart.length === 1 && /[A-D]/i.test(lastPart)) {
                        const choices = parts.slice(1, 4).map(c => c.replace(/^"|"$/g, '').trim());
                        const correctAnswer = lastPart.toUpperCase();
                        
                        if (question && choices.length === 3) {
                            questions.push({
                                domain: dataset.domain,
                                question: question,
                                choices: choices,
                                correctAnswer: correctAnswer,
                                addedAt: new Date(),
                                processed: false
                            });
                        }
                    } else {
                        skipped++;
                    }
                } else {
                    skipped++;
                }
            }

            if (questions.length > 0) {
                const targetCollection = db.collection(dataset.collection);
                await targetCollection.insertMany(questions);
                totalQuestions += questions.length;
                console.log(`Inserted ${questions.length} questions into ${dataset.collection} collection (skipped: ${skipped})`);
            }
        }

        console.log(`Total questions inserted: ${totalQuestions}`);
        broadcastProgress({ 
            message: `Database populated with ${totalQuestions} questions`,
            stage: 'populate',
            total: totalQuestions
        });

        return totalQuestions;
    } catch (error) {
        console.error('Error populating database:', error);
        throw error;
    }
}

// Query ChatGPT and record response
async function queryChatGPT(question, choices, model = "gpt-3.5-turbo") {
    const startTime = Date.now();
    
    try {
        const choiceLabels = ['A', 'B', 'C', 'D'];
        const formattedChoices = choices.map((c, i) => `${choiceLabels[i]}. ${c}`).join('\n');
        const prompt = `Question: ${question}\n\nChoices:\n${formattedChoices}\n\nPlease answer with just the letter (A, B, C, or D) of the correct choice, followed by a brief explanation.`;
        
        const completion = await openai.chat.completions.create({
            model: model,
            messages: [
                { role: "system", content: "You are a helpful assistant answering multiple choice questions. Always start your response with the answer letter (A, B, C, or D)." },
                { role: "user", content: prompt }
            ],
            max_tokens: 500,
            temperature: 0.7
        });

        const endTime = Date.now();
        const responseTime = endTime - startTime;
        const responseText = completion.choices[0].message.content;
        
        // Extract answer choice (A, B, C, D) from response - multiple strategies
        let extractedAnswer = null;
        
        // Strategy 1: Look for "Answer: X" or "The answer is X" patterns
        const answerPatterns = [
            /(?:answer|choice)\s*(?:is|:)\s*([A-D])/i,
            /^([A-D])[\.\):\s]/,  // Starts with A. or A) or A:
            /^([A-D])\b/,  // Starts with just A, B, C, or D
            /\b([A-D])[\.\)]/,  // X. or X)
            /\b([A-D])\b/  // Just the letter
        ];
        
        for (const pattern of answerPatterns) {
            const match = responseText.match(pattern);
            if (match) {
                extractedAnswer = match[1].toUpperCase();
                break;
            }
        }

        return {
            response: responseText,
            extractedAnswer: extractedAnswer,
            responseTime: responseTime,
            tokens: completion.usage.total_tokens,
            model: model,
            success: true
        };
    } catch (error) {
        const endTime = Date.now();
        console.error('OpenAI API error:', error.message);
        return {
            response: `Error: ${error.message}`,
            responseTime: endTime - startTime,
            tokens: 0,
            model: model,
            success: false,
            error: error.message
        };
    }
}

// Process all questions
async function processAllQuestions(model = "gpt-3.5-turbo") {
    try {
        // Get questions that haven't been processed by THIS model yet (LIMIT TO 50 PER DOMAIN FOR TESTING)
        // First get all questions from each domain
        const allHistoryQuestions = await historyCollection.find({}).limit(50).toArray();
        const allSocialQuestions = await socialScienceCollection.find({}).limit(50).toArray();
        const allComputerQuestions = await computerSecurityCollection.find({}).limit(50).toArray();
        
        // Filter out questions that already have results for this model
        const historyQuestions = [];
        const socialQuestions = [];
        const computerQuestions = [];
        
        for (const q of allHistoryQuestions) {
            const existingResult = await resultsCollection.findOne({ questionId: q._id, model: model });
            if (!existingResult) historyQuestions.push(q);
        }
        for (const q of allSocialQuestions) {
            const existingResult = await resultsCollection.findOne({ questionId: q._id, model: model });
            if (!existingResult) socialQuestions.push(q);
        }
        for (const q of allComputerQuestions) {
            const existingResult = await resultsCollection.findOne({ questionId: q._id, model: model });
            if (!existingResult) computerQuestions.push(q);
        }
        
        const questions = [...historyQuestions, ...socialQuestions, ...computerQuestions];
        const total = questions.length;
        let processed = 0;

        console.log(`Processing ${total} questions with ${model}...`);
        broadcastProgress({
            message: `Starting to process ${total} questions with ${model}`,
            stage: 'processing',
            total: total,
            processed: 0,
            model: model
        });

        for (const question of questions) {
            const result = await queryChatGPT(question.question, question.choices, model);
            
            const resultDoc = {
                questionId: question._id,
                domain: question.domain,
                question: question.question,
                choices: question.choices,
                correctAnswer: question.correctAnswer,
                chatgptResponse: result.response,
                extractedAnswer: result.extractedAnswer,
                isCorrect: result.extractedAnswer === question.correctAnswer,
                responseTime: result.responseTime,
                tokens: result.tokens,
                model: result.model,
                success: result.success,
                error: result.error || null,
                processedAt: new Date()
            };

            await resultsCollection.insertOne(resultDoc);
            
            // Update the appropriate collection based on domain
            let targetCollection;
            if (question.domain === 'History') targetCollection = historyCollection;
            else if (question.domain === 'Social Science') targetCollection = socialScienceCollection;
            else if (question.domain === 'Computer Security') targetCollection = computerSecurityCollection;
            
            if (targetCollection) {
                await targetCollection.updateOne(
                    { _id: question._id },
                    { $set: { processed: true, processedAt: new Date() } }
                );
            }

            processed++;
            console.log(`Processed ${processed}/${total} questions`);
            
            broadcastProgress({
                message: `Processed question ${processed}/${total} from ${question.domain}`,
                stage: 'processing',
                total: total,
                processed: processed,
                domain: question.domain,
                responseTime: result.responseTime
            });

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log('All questions processed successfully');
        broadcastProgress({
            message: 'All questions processed successfully',
            stage: 'complete',
            total: total,
            processed: processed
        });

        return { total, processed };
    } catch (error) {
        console.error('Error processing questions:', error);
        throw error;
    }
}

// Validation middleware
function validateQuery(req, res, next) {
    const { a, b } = req.query;
    
    if (a === undefined || b === undefined) {
        return res.status(400).json({ 
            error: 'Missing parameters',
            message: 'Both a and b parameters are required'
        });
    }

    const numA = parseFloat(a);
    const numB = parseFloat(b);

    if (isNaN(numA) || isNaN(numB)) {
        return res.status(400).json({ 
            error: 'Invalid numbers',
            message: 'Both a and b must be valid numbers'
        });
    }

    req.validatedNumbers = { a: numA, b: numB };
    next();
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/:section', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API route with validation middleware
app.get('/api/add', validateQuery, (req, res) => {
    const { a, b } = req.validatedNumbers;
    const result = a + b;
    res.json({ 
        a: a,
        b: b,
        result: result,
        timestamp: new Date().toISOString()
    });
});

// Populate database route
app.post('/api/populate', async (req, res) => {
    try {
        if (!db || !historyCollection || !socialScienceCollection || !computerSecurityCollection || !resultsCollection) {
            return res.status(500).json({ 
                success: false, 
                error: 'MongoDB not connected. Please ensure MongoDB is running and restart the server.'
            });
        }

        // Clear existing data from all collections
        await historyCollection.deleteMany({});
        await socialScienceCollection.deleteMany({});
        await computerSecurityCollection.deleteMany({});
        await resultsCollection.deleteMany({});
        
        const count = await populateDatabase();
        res.json({ 
            success: true, 
            message: `Database populated with ${count} questions`,
            count: count
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Process questions route
app.post('/api/process', async (req, res) => {
    try {
        if (!db || !historyCollection || !socialScienceCollection || !computerSecurityCollection || !resultsCollection) {
            return res.status(500).json({ 
                success: false, 
                error: 'MongoDB not connected. Please ensure MongoDB is running and restart the server.'
            });
        }

        const model = req.body.model || "gpt-3.5-turbo";
        const result = await processAllQuestions(model);
        res.json({ 
            success: true, 
            message: `Questions processed successfully with ${model}`,
            model: model,
            ...result
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Auto-populate and process route (all-in-one)
app.post('/api/auto-process', async (req, res) => {
    try {
        if (!db || !historyCollection || !socialScienceCollection || !computerSecurityCollection || !resultsCollection) {
            return res.status(500).json({ 
                success: false, 
                error: 'MongoDB not connected. Please ensure MongoDB is running and restart the server.'
            });
        }

        const model = req.body.model || "gpt-3.5-turbo";
        
        // Step 1: Check if database is empty
        const historyCount = await historyCollection.countDocuments();
        const socialCount = await socialScienceCollection.countDocuments();
        const securityCount = await computerSecurityCollection.countDocuments();
        const totalQuestions = historyCount + socialCount + securityCount;
        
        let populateCount = 0;
        if (totalQuestions === 0) {
            console.log('Database empty, populating from CSV files...');
            broadcastProgress({ 
                message: 'Database empty, populating from CSV files...',
                stage: 'auto-populate'
            });
            populateCount = await populateDatabase();
        }
        
        // Step 2: Check if there are unprocessed questions
        const unprocessedHistory = await historyCollection.countDocuments({ processed: false });
        const unprocessedSocial = await socialScienceCollection.countDocuments({ processed: false });
        const unprocessedSecurity = await computerSecurityCollection.countDocuments({ processed: false });
        const unprocessedTotal = unprocessedHistory + unprocessedSocial + unprocessedSecurity;
        
        if (unprocessedTotal === 0) {
            return res.json({
                success: true,
                message: 'All questions already processed',
                populated: populateCount,
                processed: 0,
                totalQuestions: totalQuestions
            });
        }
        
        // Step 3: Process all unprocessed questions
        console.log(`Auto-processing ${unprocessedTotal} unprocessed questions with ${model}...`);
        broadcastProgress({ 
            message: `Auto-processing ${unprocessedTotal} questions with ${model}...`,
            stage: 'auto-process',
            total: unprocessedTotal
        });
        
        const result = await processAllQuestions(model);
        
        res.json({ 
            success: true, 
            message: `Auto-processing complete: Populated ${populateCount} questions, processed ${unprocessedTotal} questions with ${model}`,
            populated: populateCount,
            processed: unprocessedTotal,
            model: model,
            ...result
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Evaluate endpoint - automatically processes if needed, then returns results
app.post('/api/evaluate', async (req, res) => {
    try {
        if (!db || !historyCollection || !socialScienceCollection || !computerSecurityCollection || !resultsCollection) {
            return res.status(500).json({ 
                success: false, 
                error: 'MongoDB not connected. Please ensure MongoDB is running and restart the server.'
            });
        }

        // Check if single model evaluation is requested
        const singleModel = req.body.singleModel === true;
        const requestedModel = req.body.model;
        
        // All GPT models to evaluate (or just one if singleModel is true)
        const models = singleModel && requestedModel 
            ? [requestedModel] 
            : ["gpt-3.5-turbo", "gpt-4", "gpt-4-turbo-preview", "gpt-4o", "gpt-4o-mini"];
        
        // Check if database is empty and populate if needed
        const historyCount = await historyCollection.countDocuments();
        const socialCount = await socialScienceCollection.countDocuments();
        const securityCount = await computerSecurityCollection.countDocuments();
        const totalQuestions = historyCount + socialCount + securityCount;
        
        if (totalQuestions === 0) {
            console.log('Database empty, populating from CSV files...');
            broadcastProgress({ 
                message: 'Auto-populating database...',
                stage: 'evaluate-populate'
            });
            await populateDatabase();
        }
        
        // Check if there are questions not yet processed by the requested model(s)
        let unprocessedTotal = 0;
        for (const model of models) {
            const allQuestions = await historyCollection.find({}).limit(50).toArray();
            const allSocial = await socialScienceCollection.find({}).limit(50).toArray();
            const allSecurity = await computerSecurityCollection.find({}).limit(50).toArray();
            
            for (const q of allQuestions) {
                const exists = await resultsCollection.findOne({ questionId: q._id, model: model });
                if (!exists) unprocessedTotal++;
            }
            for (const q of allSocial) {
                const exists = await resultsCollection.findOne({ questionId: q._id, model: model });
                if (!exists) unprocessedTotal++;
            }
            for (const q of allSecurity) {
                const exists = await resultsCollection.findOne({ questionId: q._id, model: model });
                if (!exists) unprocessedTotal++;
            }
        }
        
        // Process all models in background (don't wait)
        if (unprocessedTotal > 0) {
            console.log(`Starting evaluation of ${unprocessedTotal} questions with all ${models.length} GPT models...`);
            broadcastProgress({ 
                message: `Evaluating ${unprocessedTotal} questions with all GPT models (${models.join(', ')})...`,
                stage: 'evaluate-processing',
                total: unprocessedTotal * models.length,
                models: models
            });
            
            // Process all models sequentially in background
            (async () => {
                for (const model of models) {
                    console.log(`Processing with ${model}...`);
                    broadcastProgress({ 
                        message: `Now evaluating with ${model}...`,
                        stage: 'evaluate-model',
                        currentModel: model,
                        total: unprocessedTotal
                    });
                    
                    try {
                        await processAllQuestions(model);
                        console.log(`✅ Completed evaluation with ${model}`);
                    } catch (err) {
                        console.error(`❌ Error processing with ${model}:`, err);
                    }
                }
                
                console.log('All models evaluated successfully');
                broadcastProgress({ 
                    message: 'All GPT models evaluated successfully!',
                    stage: 'evaluate-complete',
                    total: unprocessedTotal * models.length,
                    processed: unprocessedTotal * models.length
                });
            })().catch(err => {
                console.error('Background processing error:', err);
            });
        }
        
        // Immediately return current results (will be updated as processing continues)
        res.json({ 
            success: true, 
            message: unprocessedTotal > 0 
                ? `Evaluation started for ${unprocessedTotal} questions across ${models.length} GPT models. Results will update in real-time via WebSocket.`
                : 'All questions already evaluated. Displaying results.',
            processing: unprocessedTotal > 0,
            unprocessed: unprocessedTotal,
            models: models,
            totalEvaluations: unprocessedTotal * models.length
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Get evaluation results
app.get('/api/results', async (req, res) => {
    try {
        const modelFilter = req.query.model;

        if (!db || !resultsCollection) {
            const fallbackMetrics = loadExportedMetrics(modelFilter);
            if (fallbackMetrics) {
                return res.json({
                    success: true,
                    metrics: fallbackMetrics,
                    results: [],
                    source: 'results-export.json',
                    generatedAt: new Date().toISOString()
                });
            }

            return res.status(503).json({
                success: false,
                error: 'MongoDB not connected and no exported results file was found.'
            });
        }

        const query = modelFilter ? { model: modelFilter } : {};
        const results = await resultsCollection.find(query).toArray();
        
        // Calculate metrics
        const correctAnswers = results.filter(r => r.isCorrect).length;
        const metrics = {
            totalQuestions: results.length,
            successfulResponses: results.filter(r => r.success).length,
            failedResponses: results.filter(r => !r.success).length,
            correctAnswers: correctAnswers,
            incorrectAnswers: results.length - correctAnswers,
            overallAccuracy: results.length > 0 ? ((correctAnswers / results.length) * 100).toFixed(2) : 0,
            models: {},
            domains: {}
        };

        // Group by model and domain
        results.forEach(result => {
            const modelName = result.model || 'unknown';
            
            // Group by model
            if (!metrics.models[modelName]) {
                metrics.models[modelName] = {
                    count: 0,
                    avgResponseTime: 0,
                    totalTokens: 0,
                    successful: 0,
                    failed: 0,
                    correct: 0,
                    incorrect: 0,
                    accuracy: 0,
                    domains: {}
                };
            }
            
            const model = metrics.models[modelName];
            model.count++;
            model.avgResponseTime += result.responseTime;
            model.totalTokens += result.tokens;
            if (result.success) model.successful++;
            else model.failed++;
            if (result.isCorrect) model.correct++;
            else model.incorrect++;
            
            // Group by domain within model
            if (!model.domains[result.domain]) {
                model.domains[result.domain] = {
                    count: 0,
                    avgResponseTime: 0,
                    totalTokens: 0,
                    successful: 0,
                    failed: 0,
                    correct: 0,
                    incorrect: 0,
                    accuracy: 0
                };
            }
            
            const modelDomain = model.domains[result.domain];
            modelDomain.count++;
            modelDomain.avgResponseTime += result.responseTime;
            modelDomain.totalTokens += result.tokens;
            if (result.success) modelDomain.successful++;
            else modelDomain.failed++;
            if (result.isCorrect) modelDomain.correct++;
            else modelDomain.incorrect++;
            
            // Group by domain (overall)
            if (!metrics.domains[result.domain]) {
                metrics.domains[result.domain] = {
                    count: 0,
                    avgResponseTime: 0,
                    totalTokens: 0,
                    successful: 0,
                    failed: 0,
                    correct: 0,
                    incorrect: 0,
                    accuracy: 0
                };
            }

            const domain = metrics.domains[result.domain];
            domain.count++;
            domain.avgResponseTime += result.responseTime;
            domain.totalTokens += result.tokens;
            if (result.success) domain.successful++;
            else domain.failed++;
            if (result.isCorrect) domain.correct++;
            else domain.incorrect++;
        });

        // Calculate averages for models
        Object.keys(metrics.models).forEach(modelName => {
            const m = metrics.models[modelName];
            m.avgResponseTime = Math.round(m.avgResponseTime / m.count);
            m.accuracy = ((m.correct / m.count) * 100).toFixed(2);
            
            // Calculate averages for domains within model
            Object.keys(m.domains).forEach(domain => {
                const d = m.domains[domain];
                d.avgResponseTime = Math.round(d.avgResponseTime / d.count);
                d.accuracy = ((d.correct / d.count) * 100).toFixed(2);
            });
        });
        
        // Calculate averages for domains overall
        Object.keys(metrics.domains).forEach(domain => {
            const d = metrics.domains[domain];
            d.avgResponseTime = Math.round(d.avgResponseTime / d.count);
            d.accuracy = ((d.correct / d.count) * 100).toFixed(2);
        });

        // Overall stats
        metrics.overallAvgResponseTime = Math.round(
            results.reduce((sum, r) => sum + r.responseTime, 0) / results.length
        );
        metrics.totalTokensUsed = results.reduce((sum, r) => sum + r.tokens, 0);

        res.json({
            success: true,
            metrics: metrics,
            results: results,
            generatedAt: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Get questions route
app.get('/api/questions', async (req, res) => {
    try {
        if (!db || !historyCollection || !socialScienceCollection || !computerSecurityCollection) {
            return res.status(500).json({ 
                success: false, 
                error: 'MongoDB not connected. Please ensure MongoDB is running and restart the server.'
            });
        }

        const domain = req.query.domain;
        let questions = [];
        
        if (domain === 'History') {
            questions = await historyCollection.find({}).toArray();
        } else if (domain === 'Social Science') {
            questions = await socialScienceCollection.find({}).toArray();
        } else if (domain === 'Computer Security') {
            questions = await computerSecurityCollection.find({}).toArray();
        } else {
            // Get all questions from all collections
            const history = await historyCollection.find({}).toArray();
            const social = await socialScienceCollection.find({}).toArray();
            const computer = await computerSecurityCollection.find({}).toArray();
            questions = [...history, ...social, ...computer];
        }
        
        res.json({
            success: true,
            count: questions.length,
            questions: questions
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Database status route
app.get('/api/status', async (req, res) => {
    try {
        if (!db || !historyCollection || !socialScienceCollection || !computerSecurityCollection || !resultsCollection) {
            const fallbackMetrics = loadExportedMetrics();
            return res.json({
                success: true,
                database: {
                    connected: false,
                    totalQuestions: fallbackMetrics?.totalQuestions || 0,
                    processedQuestions: fallbackMetrics?.totalQuestions || 0,
                    unprocessedQuestions: 0,
                    totalResults: fallbackMetrics?.totalQuestions || 0,
                    storageType: fallbackMetrics ? 'results-export.json fallback' : 'none',
                    message: fallbackMetrics
                        ? 'MongoDB not connected. Displaying exported results.'
                        : 'MongoDB not connected. Please ensure MongoDB is running.'
                }
            });
        }

        const historyCount = await historyCollection.countDocuments();
        const socialCount = await socialScienceCollection.countDocuments();
        const computerCount = await computerSecurityCollection.countDocuments();
        const totalQuestions = historyCount + socialCount + computerCount;
        
        const historyProcessed = await historyCollection.countDocuments({ processed: true });
        const socialProcessed = await socialScienceCollection.countDocuments({ processed: true });
        const computerProcessed = await computerSecurityCollection.countDocuments({ processed: true });
        const processedQuestions = historyProcessed + socialProcessed + computerProcessed;
        
        const totalResults = await resultsCollection.countDocuments();
        
        res.json({
            success: true,
            database: {
                connected: true,
                totalQuestions: totalQuestions,
                processedQuestions: processedQuestions,
                unprocessedQuestions: totalQuestions - processedQuestions,
                totalResults: totalResults
            }
        });
    } catch (error) {
        res.json({ 
            success: false,
            database: {
                connected: false,
                totalQuestions: 0,
                processedQuestions: 0,
                unprocessedQuestions: 0,
                totalResults: 0
            },
            error: error.message 
        });
    }
});

// Drop old database route
app.post('/api/drop-old-database', async (req, res) => {
    try {
        const client = await MongoClient.connect(MONGODB_URI);
        const oldDb = client.db('chatgpt_evaluation');
        await oldDb.dropDatabase();
        await client.close();
        
        res.json({ 
            success: true, 
            message: 'Old database dropped successfully'
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Reset processed status route
app.post('/api/reset-processed', async (req, res) => {
    try {
        if (!db || !historyCollection || !socialScienceCollection || !computerSecurityCollection || !resultsCollection) {
            return res.status(500).json({ 
                success: false, 
                error: 'MongoDB not connected. Please ensure MongoDB is running and restart the server.'
            });
        }

        // Clear all results
        const resultsDeleted = await resultsCollection.deleteMany({});
        
        // Reset processed status
        const historyResult = await historyCollection.updateMany(
            {},
            { $set: { processed: false }, $unset: { processedAt: "" } }
        );
        const socialResult = await socialScienceCollection.updateMany(
            {},
            { $set: { processed: false }, $unset: { processedAt: "" } }
        );
        const computerResult = await computerSecurityCollection.updateMany(
            {},
            { $set: { processed: false }, $unset: { processedAt: "" } }
        );
        
        const totalModified = historyResult.modifiedCount + socialResult.modifiedCount + computerResult.modifiedCount;
        console.log(`✅ Cleared ${resultsDeleted.deletedCount} results and reset ${totalModified} questions to unprocessed`);
        
        res.json({ 
            success: true, 
            message: `Cleared ${resultsDeleted.deletedCount} results and reset ${totalModified} questions to unprocessed`,
            resultsDeleted: resultsDeleted.deletedCount,
            questionsReset: totalModified
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Start server
async function startServer() {
    const dbConnected = await connectToMongoDB();
    
    if (!dbConnected) {
        console.log('\n⚠️  WARNING: MongoDB not connected.');
        console.log('    Server will start, but database features will not work.');
        console.log('    Please start MongoDB and restart the server.\n');
    }

    server.listen(port, async () => {
        console.log(`\n========================================`);
        console.log(`🚀 Server running on http://localhost:${port}`);
        console.log(`📡 WebSocket server is ready`);
        console.log(`💾 MongoDB: ${dbConnected ? '✅ Connected' : '❌ Not Connected'}`);
        console.log(`========================================\n`);
        console.log('📋 Available endpoints:');
        console.log('  GET  /                      - Main website');
        console.log('  GET  /api/add?a=1&b=2       - Add two numbers');
        console.log('  POST /api/populate          - Populate database from CSV');
        console.log('  POST /api/process           - Process questions with ChatGPT');
        console.log('  POST /api/auto-process      - Auto-populate & process all');
        console.log('  POST /api/evaluate          - Auto-evaluate & return results');
        console.log('  GET  /api/results           - Get evaluation metrics');
        console.log('  GET  /api/questions         - Get all questions');
        console.log('  GET  /api/status            - Get database status');
        console.log('========================================\n');
        
        if (!dbConnected) {
            console.log('💡 To start MongoDB:');
            console.log('   net start MongoDB');
            console.log('   OR');
            console.log('   mongod --dbpath="C:\\data\\db"\n');
        }
    });
}

startServer();
